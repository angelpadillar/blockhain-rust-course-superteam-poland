use {
    crate::{
        error::{require, Error, Result, WillError},
        payout::check_vault,
        state::{status, Config, Job, LeU64},
        util::{
            check_address, check_signer, check_writable, parse, token_account_owner,
            token_transfer, TOKEN_PROGRAM_ID,
        },
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 6;

/// Operator-only: records the merchant order (by hash) and what it actually
/// cost. `charged` (USDC) may not exceed what was released; the operator
/// returns `released - charged` from its own USDC account into the vault in
/// this same instruction, so unspent funds never stay on the card account.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "recordPurchase"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 6))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "operator", signer)))]
#[cfg_attr(feature = "idl", codama(account(name = "operator_token", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
pub struct RecordPurchase {
    /// SHA-256 of the merchant's order reference.
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub order_ref_hash: [u8; 32],
    /// USDC the card charge actually consumed.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub charged: LeU64,
    /// The charge in the quote's currency minor units.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub charged_quote_amount: LeU64,
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, operator, operator_token, token_program, ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &RecordPurchase = parse(args)?;
    let config = Config::load(config)?;
    let job_view = *job_account;
    let job = Job::load_mut(&job_view)?;
    check_signer(operator)?;
    require(
        operator.address() == &config.operator,
        WillError::NotOperator,
    )?;
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    require(job.status == status::RELEASED, WillError::BadState)?;

    let charged = args.charged.get();
    let charged_quote_amount = args.charged_quote_amount.get();
    require(
        args.order_ref_hash != [0; 32] && charged > 0 && charged_quote_amount > 0,
        WillError::BadAmount,
    )?;
    let released = job.released.get();
    require(
        charged <= released && charged_quote_amount <= job.quote.ceiling.get(),
        WillError::CapExceeded,
    )?;

    let excess = released - charged;
    if excess > 0 {
        check_vault(vault, job_account, job, config)?;
        check_writable(operator_token)?;
        require(
            token_account_owner(operator_token, &config.mint)? == operator.address(),
            WillError::NotOperator,
        )?;
        token_transfer(operator_token, vault, operator, excess, &[])?;
    }

    job.order_ref_hash = args.order_ref_hash;
    job.charged = args.charged;
    job.charged_quote_amount = args.charged_quote_amount;
    job.status = status::PURCHASED;
    Ok(())
}
