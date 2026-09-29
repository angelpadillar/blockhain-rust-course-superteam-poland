use {
    crate::{
        error::{require, Error, Result, WillError},
        state::{status, Job},
        util::{bytes_of, check_signer, now, parse},
        ID,
    },
    pinocchio::{AccountView, Address},
};

pub const DISCRIMINATOR: u8 = 4;

const DOMAIN: &[u8] = b"will-escrow:terms:v1";

/// The customer approves the job's current quote by signing its exact terms:
/// `terms_hash` must equal [`terms_hash`] of the stored quote, so a signature
/// over a replaced quote cannot approve its successor.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "approveQuote"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 4))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer", signer)))]
pub struct ApproveQuote {
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub terms_hash: [u8; 32],
}

/// SHA-256 over the domain, program id, job key, quote currency and exponent,
/// the five line items and ceiling, `release_cap`, `quote_hash`,
/// `quote_expires_at` and the job's fee rate. Integers are little-endian.
pub fn terms_hash(job_key: &Address, job: &Job) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        DOMAIN,
        ID.as_ref(),
        job_key.as_ref(),
        &job.quote_currency,
        &[job.quote_exponent],
        bytes_of(&job.quote),
        job.release_cap.bytes(),
        &job.quote_hash,
        job.quote_expires_at.bytes(),
        job.fee_bps.bytes(),
    ])
    .to_bytes()
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [job_account, customer, ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &ApproveQuote = parse(args)?;
    let job = Job::load_mut(job_account)?;
    check_signer(customer)?;
    require(customer.address() == &job.customer, WillError::NotCustomer)?;
    require(job.status == status::QUOTED, WillError::BadState)?;
    require(now()? < job.quote_expires_at.get(), WillError::QuoteExpired)?;
    require(
        args.terms_hash == terms_hash(job_account.address(), job),
        WillError::TermsMismatch,
    )?;
    job.status = status::APPROVED;
    Ok(())
}
