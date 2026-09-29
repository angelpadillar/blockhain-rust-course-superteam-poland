use {
    crate::{
        error::{require, Error, Result, WillError},
        state::{status, Config, Job, LeI64, LeU64, Quote},
        util::{check_signer, now, parse},
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 3;

/// `flags` bit set when the customer's mandate approved the quote.
pub const APPROVED_BY_MANDATE: u8 = 1;

/// Operator-only: records an itemized quote (in the merchant's currency) and
/// the USDC `release_cap` the purchase may draw from the vault. Replaces an
/// unapproved quote. A quote within the job's live mandate is approved
/// immediately.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "submitQuote"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 3))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "operator", signer)))]
pub struct SubmitQuote {
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 3)))]
    pub quote_currency: [u8; 3],
    pub quote_exponent: u8,
    pub quote: Quote,
    /// Must equal the sum of the five line items.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub total: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub release_cap: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub quote_expires_at: LeI64,
    /// SHA-256 of the full off-chain quote document.
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub quote_hash: [u8; 32],
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, operator, ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &SubmitQuote = parse(args)?;
    let config = Config::load(config)?;
    let job = Job::load_mut(job_account)?;
    check_signer(operator)?;
    require(
        operator.address() == &config.operator,
        WillError::NotOperator,
    )?;
    require(
        matches!(job.status, status::FUNDED | status::QUOTED),
        WillError::BadState,
    )?;
    require(
        args.quote_currency.iter().all(u8::is_ascii_uppercase)
            && args.quote_exponent <= 4
            && args.quote_hash != [0; 32],
        WillError::BadAmount,
    )?;
    let quote = &args.quote;
    let sum = [
        &quote.service_fee,
        &quote.delivery_fee,
        &quote.tip,
        &quote.other,
    ]
    .into_iter()
    .try_fold(quote.item.get(), |total, part| {
        total.checked_add(part.get())
    })
    .ok_or(WillError::Overflow)?;
    let total = args.total.get();
    require(total > 0 && sum == total, WillError::BadAmount)?;
    require(total <= quote.ceiling.get(), WillError::CapExceeded)?;
    let release_cap = args.release_cap.get();
    require(release_cap > 0, WillError::BadAmount)?;
    require(release_cap <= job.budget.get(), WillError::CapExceeded)?;
    let now = now()?;
    let quote_expires_at = args.quote_expires_at.get();
    require(
        quote_expires_at > now && quote_expires_at <= job.expires_at.get(),
        WillError::QuoteExpired,
    )?;

    job.quote_currency = args.quote_currency;
    job.quote_exponent = args.quote_exponent;
    job.quote = *quote;
    job.release_cap = args.release_cap;
    job.quote_expires_at = args.quote_expires_at;
    job.quote_hash = args.quote_hash;
    let mandate_cap = job.mandate_cap.get();
    if mandate_cap > 0 && release_cap <= mandate_cap && now < job.mandate_expires_at.get() {
        job.status = status::APPROVED;
        job.flags |= APPROVED_BY_MANDATE;
    } else {
        job.status = status::QUOTED;
    }
    Ok(())
}
