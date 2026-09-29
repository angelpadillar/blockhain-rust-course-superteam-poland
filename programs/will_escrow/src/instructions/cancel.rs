use {
    crate::{
        error::{require, Error, Result, WillError},
        payout::{close_job, Recipients},
        state::{status, Config, Job, LeU64},
        util::{check_address, check_signer, parse, TOKEN_PROGRAM_ID},
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 11;

/// Ends a job with a full refund to the customer and no fee. The customer
/// may cancel until they approve a quote.
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
pub struct Cancel {
    /// USDC the operator returns into the vault before the refund.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub returned: LeU64,
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, customer_token, rent_payer, signer, token_program, ..] =
        accounts
    else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let _args: &Cancel = parse(args)?;
    let config = Config::load(config)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_signer(signer)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    require(signer.address() == &job.customer, WillError::NotCustomer)?;
    require(
        matches!(job.status, status::FUNDED | status::QUOTED),
        WillError::BadState,
    )?;
    let recipients = Recipients {
        vault,
        customer_token,
        rent_payer,
        treasury_token: None,
    };
    close_job(config, job_account, job, recipients, 0)?;
    Ok(())
}
