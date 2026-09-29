use {
    super::settle::earned_fee,
    crate::{
        error::{require, Error, Result, WillError},
        payout::{close_job, Recipients},
        state::{status, Config, Job, LeU64},
        util::{check_address, check_signer, parse, TOKEN_PROGRAM_ID},
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 10;

/// Admin-only (a Squads multisig on mainnet): ends a disputed job, awarding
/// the operator at most the fee it would have earned and the customer the
/// rest of the vault. Accounts close as in `settle`.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "resolveDispute"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 10))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "treasury_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "rent_payer", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "admin", signer)))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
pub struct ResolveDispute {
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub fee_to_operator: LeU64,
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, customer_token, treasury_token, rent_payer, admin, token_program, ..] =
        accounts
    else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &ResolveDispute = parse(args)?;
    let config = Config::load(config)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_signer(admin)?;
    require(admin.address() == &config.admin, WillError::NotAdmin)?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    require(job.status == status::DISPUTED, WillError::BadState)?;
    let fee = args.fee_to_operator.get();
    require(fee <= earned_fee(job)?, WillError::CapExceeded)?;
    let recipients = Recipients {
        vault,
        customer_token,
        rent_payer,
        treasury_token: Some(treasury_token),
    };
    close_job(config, job_account, job, recipients, fee)?;
    Ok(())
}
