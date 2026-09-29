//! Every way a job ends goes through [`close_job`]: the vault pays the fee (if
//! any) to the treasury and everything else to the customer, then the vault
//! and the job are closed and their rent returns to the recorded rent payer.
//! Nothing is ever paid to the caller.

use {
    crate::{
        error::{require, Result, WillError},
        state::{Config, Job, JOB_SEED, VAULT_SEED},
        util::{
            check_distinct, check_pda, check_writable, token_account_owner, token_amount,
            token_close, token_transfer,
        },
    },
    pinocchio::{
        cpi::{Seed, Signer},
        AccountView,
    },
};

/// The accounts that receive a job's funds and rent.
pub struct Recipients<'a> {
    pub vault: &'a AccountView,
    /// A USDC account owned by the job's customer.
    pub customer_token: &'a AccountView,
    /// Must be the job's recorded rent payer.
    pub rent_payer: &'a mut AccountView,
    /// A USDC account owned by the config treasury; required when `fee > 0`.
    pub treasury_token: Option<&'a AccountView>,
}

/// The job's vault: its PDA with the stored bump, a token account of the
/// config mint owned by the job.
pub fn check_vault(
    vault: &AccountView,
    job_account: &AccountView,
    job: &Job,
    config: &Config,
) -> Result {
    check_writable(vault)?;
    check_pda(
        vault,
        [
            VAULT_SEED,
            job_account.address().as_ref(),
            &[job.vault_bump],
            &[],
        ],
    )?;
    require(
        token_account_owner(vault, &config.mint)? == job_account.address(),
        WillError::WrongRecipient,
    )
}

/// Runs `f` with the job PDA's signer seeds (the vault's authority).
pub fn with_job_signer<R>(job: &Job, f: impl FnOnce(&[Signer]) -> Result<R>) -> Result<R> {
    let bump = [job.bump];
    let seeds = [
        Seed::from(JOB_SEED),
        Seed::from(job.customer.as_ref()),
        Seed::from(job.job_id.bytes()),
        Seed::from(&bump),
    ];
    f(&[Signer::from(&seeds)])
}

/// Pays `fee` to the treasury and the rest of the vault to the customer, then
/// closes the vault and the job. Returns the customer's refund.
pub fn close_job(
    config: &Config,
    job_account: &mut AccountView,
    job: &Job,
    to: Recipients,
    fee: u64,
) -> Result<u64> {
    check_vault(to.vault, job_account, job, config)?;
    check_writable(to.customer_token)?;
    require(
        token_account_owner(to.customer_token, &config.mint)? == &job.customer,
        WillError::WrongRecipient,
    )?;
    check_distinct(to.vault, to.customer_token)?;
    check_writable(to.rent_payer)?;
    require(
        to.rent_payer.address() == &job.rent_payer,
        WillError::WrongRecipient,
    )?;

    let balance = token_amount(to.vault);
    let refund = balance.checked_sub(fee).ok_or(WillError::Overflow)?;
    let treasury_token = match fee {
        0 => None,
        _ => {
            let treasury_token = to.treasury_token.ok_or(WillError::WrongRecipient)?;
            check_writable(treasury_token)?;
            require(
                token_account_owner(treasury_token, &config.mint)? == &config.treasury,
                WillError::WrongRecipient,
            )?;
            check_distinct(to.vault, treasury_token)?;
            Some(treasury_token)
        }
    };
    with_job_signer(job, |signer| {
        if let Some(treasury_token) = treasury_token {
            token_transfer(to.vault, treasury_token, job_account, fee, signer)?;
        }
        if refund > 0 {
            token_transfer(to.vault, to.customer_token, job_account, refund, signer)?;
        }
        token_close(to.vault, to.rent_payer, job_account, signer)
    })?;

    // The job's own lamports: move them out first, then zero the owner,
    // lamports and length so the account cannot be revived.
    let lamports = job_account.lamports();
    let rent_payer_lamports = to
        .rent_payer
        .lamports()
        .checked_add(lamports)
        .ok_or(WillError::Overflow)?;
    to.rent_payer.set_lamports(rent_payer_lamports);
    job_account.set_lamports(0);
    job_account.close()?;
    Ok(refund)
}
