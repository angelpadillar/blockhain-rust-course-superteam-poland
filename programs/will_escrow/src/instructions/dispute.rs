use {
    crate::{
        error::{require, Error, Result, WillError},
        state::{status, Config, Job},
        util::{check_signer, now, parse},
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 8;

/// Customer-only, inside the dispute window: freezes the job for the admin
/// (`resolve_dispute`). If nobody resolves it, anyone may refund the customer
/// once the dispute timeout, fixed now, has passed.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "dispute"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 8))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer", signer)))]
pub struct Dispute {
    /// SHA-256 of the customer's complaint (kept in the transaction, not stored).
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub reason_hash: [u8; 32],
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, customer, ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let _args: &Dispute = parse(args)?;
    let config = Config::load(config)?;
    let job = Job::load_mut(job_account)?;
    check_signer(customer)?;
    require(customer.address() == &job.customer, WillError::NotCustomer)?;
    require(job.status == status::PROVEN, WillError::BadState)?;
    let now = now()?;
    require(now < job.window_ends_at.get(), WillError::WindowClosed)?;
    let dispute_expires_at = now
        .checked_add(i64::from(config.dispute_timeout.get()))
        .ok_or(WillError::Overflow)?;
    job.dispute_expires_at.set(dispute_expires_at);
    job.status = status::DISPUTED;
    Ok(())
}
