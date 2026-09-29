use {
    crate::{
        error::{require, Error, Result, WillError},
        payout::{close_job, Recipients},
        state::{status, Config, Job},
        util::{check_address, check_signer, mul, now, parse, slot, TOKEN_PROGRAM_ID},
        BASIS_POINTS,
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 9;

/// Ends a proven job: the earned fee (`charged * fee_bps / 10_000`, at the
/// rate fixed when the job was created) to the treasury, everything else to
/// the customer, accounts closed. The customer may sign off at any time; once
/// the dispute window has ended anyone may settle, and the caller receives
/// nothing.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "settle"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 9))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "treasury_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "rent_payer", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "caller", signer)))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
pub struct Settle {}

/// The fee earned on a completed purchase, rounded down.
pub(crate) fn earned_fee(job: &Job) -> Result<u64> {
    mul(job.charged.get(), u64::from(job.fee_bps.get()))
        .map(|product| product / BASIS_POINTS)
        .ok_or_else(|| WillError::Overflow.into())
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, customer_token, treasury_token, rent_payer, caller, token_program, ..] =
        accounts
    else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let _args: &Settle = parse(args)?;
    let config = Config::load(config)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_signer(caller)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    require(job.status == status::PROVEN, WillError::BadState)?;
    if caller.address() == &job.customer {
        // Early sign-off, but never in the proof's own transaction: a
        // customer-signed bundle built by the operator must not skip the window.
        require(slot()? > job.proof_slot.get(), WillError::SignOffTooEarly)?;
    } else {
        require(now()? >= job.window_ends_at.get(), WillError::WindowOpen)?;
    }
    let fee = earned_fee(job)?;
    let recipients = Recipients {
        vault,
        customer_token,
        rent_payer,
        treasury_token: Some(treasury_token),
    };
    close_job(config, job_account, job, recipients, fee)?;
    Ok(())
}
