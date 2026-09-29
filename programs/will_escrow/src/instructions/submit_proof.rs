use {
    crate::{
        error::{require, Error, Result, WillError},
        state::{status, Config, Job},
        util::{check_signer, now, parse},
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 7;

/// Operator-only, after the purchase: commits the proof of delivery (by hash)
/// and opens the customer's dispute window, whose end is fixed now from the
/// configured length.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "submitProof"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 7))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "operator", signer)))]
pub struct SubmitProof {
    /// SHA-256 of the delivery evidence (photo, courier receipt, ...).
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub proof_hash: [u8; 32],
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, operator, ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &SubmitProof = parse(args)?;
    let config = Config::load(config)?;
    let job = Job::load_mut(job_account)?;
    check_signer(operator)?;
    require(
        operator.address() == &config.operator,
        WillError::NotOperator,
    )?;
    require(job.status == status::PURCHASED, WillError::BadState)?;
    require(args.proof_hash != [0; 32], WillError::BadAmount)?;
    let window_ends_at = now()?
        .checked_add(i64::from(config.dispute_window.get()))
        .ok_or(WillError::Overflow)?;
    job.proof_hash = args.proof_hash;
    job.window_ends_at.set(window_ends_at);
    job.status = status::PROVEN;
    Ok(())
}
