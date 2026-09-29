use {
    crate::{
        error::{require, Error, Result, WillError},
        payout::{close_job, Recipients},
        state::{status, Config, Job},
        util::{check_address, now, parse, TOKEN_PROGRAM_ID},
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 12;

/// Permissionless exit so funds can never get stuck: anyone may refund an
/// unfinished job (FUNDED..=PURCHASED) once `expires_at` has passed, or a
/// dispute once `dispute_timeout` has passed since it opened. Everything goes
/// to the customer and the rent to the rent payer; the caller gets nothing.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "refundExpired"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 12))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "rent_payer", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
pub struct RefundExpired {}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, customer_token, rent_payer, token_program, ..] = accounts
    else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let _args: &RefundExpired = parse(args)?;
    let config = Config::load(config)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    let now = now()?;
    let deadline = match job.status {
        status::FUNDED..=status::PURCHASED => job.expires_at.get(),
        status::DISPUTED => job
            .disputed_at
            .get()
            .checked_add(i64::from(config.dispute_timeout.get()))
            .ok_or(WillError::Overflow)?,
        _ => return Err(WillError::BadState.into()),
    };
    require(now >= deadline, WillError::NotExpired)?;
    let recipients = Recipients {
        vault,
        customer_token,
        rent_payer,
        treasury_token: None,
    };
    close_job(config, job_account, job, recipients, 0)?;
    Ok(())
}
