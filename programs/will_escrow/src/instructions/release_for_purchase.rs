use {
    crate::{
        error::{require, Error, Result, WillError},
        payout::{check_vault, with_job_signer},
        state::{status, Config, Job, LeU64},
        util::{
            check_address, check_distinct, check_signer, check_writable, now, parse,
            token_account_owner, token_transfer, TOKEN_PROGRAM_ID,
        },
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 5;

/// Operator-only, at purchase time: sends `amount` of the approved release
/// cap from the vault to an allowlisted funding account (the Altitude card
/// deposit). The fee reserve and any unreleased budget stay locked. Further
/// releases may top up to the cap until the purchase is recorded.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "releaseForPurchase"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 5))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "funding", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "operator", signer)))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
pub struct ReleaseForPurchase {
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub amount: LeU64,
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, funding, operator, token_program, ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &ReleaseForPurchase = parse(args)?;
    let config = Config::load(config)?;
    require(config.paused == 0, WillError::Paused)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_signer(operator)?;
    require(
        operator.address() == &config.operator,
        WillError::NotOperator,
    )?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    require(
        matches!(job.status, status::APPROVED | status::RELEASED),
        WillError::BadState,
    )?;

    let allowlist = config
        .funding
        .get(..usize::from(config.funding_count))
        .unwrap_or(&[]);
    require(
        allowlist.contains(funding.address()),
        WillError::FundingNotAllowed,
    )?;
    check_writable(funding)?;
    token_account_owner(funding, &config.mint)
        .map_err(|_| Error::from(WillError::FundingNotAllowed))?;
    check_vault(vault, job_account, job, config)?;
    check_distinct(vault, funding).map_err(|_| Error::from(WillError::FundingNotAllowed))?;

    let amount = args.amount.get();
    require(amount > 0, WillError::BadAmount)?;
    let released = job.released.get().checked_add(amount);
    require(
        released.is_some_and(|total| total <= job.release_cap.get()),
        WillError::CapExceeded,
    )?;
    if job.status == status::APPROVED {
        require(now()? < job.quote_expires_at.get(), WillError::QuoteExpired)?;
    }

    with_job_signer(job, |signer| {
        token_transfer(vault, funding, job_account, amount, signer)
    })?;
    job.released.set(released.unwrap_or_default());
    job.status = status::RELEASED;
    Ok(())
}
