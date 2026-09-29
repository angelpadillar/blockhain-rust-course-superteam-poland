use {
    crate::{
        error::{require, Error, Result, WillError},
        payout::{check_vault, close_job, Recipients},
        state::{status, Config, Job, LeU64},
        util::{
            check_address, check_signer, check_writable, parse, token_account_owner, token_amount,
            token_transfer, TOKEN_PROGRAM_ID,
        },
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 11;

/// Ends a job with a full refund to the customer and no fee. The customer
/// may cancel until they approve a quote. The operator may cancel at any
/// stage except a dispute (no-show, failed checkout, merchant refund); it
/// must return exactly what the vault is missing (`budget + fee_reserve -
/// vault balance`) from its own USDC account, the optional trailing account,
/// so the customer always gets their whole deposit back.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "cancel"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 11))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "rent_payer", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "signer", signer)))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
#[cfg_attr(
    feature = "idl",
    codama(remaining_accounts(
        argument("return_source"),
        writable,
        docs = "Operator USDC account the return comes from (only when returned > 0)."
    ))
)]
pub struct Cancel {
    /// USDC the operator returns into the vault before the refund.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub returned: LeU64,
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, customer_token, rent_payer, signer, token_program, rest @ ..] =
        accounts
    else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &Cancel = parse(args)?;
    let config = Config::load(config)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_signer(signer)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    let returned = args.returned.get();
    let before_approval = matches!(job.status, status::FUNDED | status::QUOTED);

    if signer.address() == &job.customer && before_approval {
        require(returned == 0, WillError::BadAmount)?;
    } else if signer.address() == &config.operator {
        // Refund after booking: the operator makes the customer whole.
        require(job.status <= status::PROVEN, WillError::BadState)?;
        check_vault(vault, job_account, job, config)?;
        let deposit = job
            .budget
            .get()
            .checked_add(job.fee_reserve.get())
            .ok_or(WillError::Overflow)?;
        require(
            returned == deposit.saturating_sub(token_amount(vault)),
            WillError::BadAmount,
        )?;
        if returned > 0 {
            let [source_token, ..] = rest else {
                return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
            };
            check_writable(source_token)?;
            require(
                token_account_owner(source_token, &config.mint)? == signer.address(),
                WillError::NotOperator,
            )?;
            token_transfer(source_token, vault, signer, returned, &[])?;
        }
    } else if signer.address() == &job.customer {
        return Err(WillError::BadState.into());
    } else {
        return Err(WillError::NotCustomer.into());
    }

    let recipients = Recipients {
        vault,
        customer_token,
        rent_payer,
        treasury_token: None,
    };
    close_job(config, job_account, job, recipients, 0)?;
    Ok(())
}
