use {
    crate::{
        error::{require, Error, Result, WillError},
        state::{status, Config, Job, LeI64, LeU64, JOB_SEED, JOB_TAG, VAULT_SEED, VERSION},
        util::{
            check_address, check_payer, check_signer, check_writable, init_pda, mul, now, parse,
            token_account_owner, token_initialize_account, token_transfer, SYSTEM_PROGRAM_ID,
            TOKEN_PROGRAM_ID,
        },
        ID,
    },
    pinocchio::AccountView,
};

pub const DISCRIMINATOR: u8 = 2;

/// Job kinds and adapters are u8 codes; the program accepts 0..=15.
pub const MAX_CODE: u8 = 15;
const TOKEN_ACCOUNT_LEN: usize = 165;

/// Opens a job: the customer funds `budget` plus the fee reserve
/// (`ceil(budget * fee_bps / 10_000)`) into a new per-job vault. The rent
/// payer (normally the operator) pays and later recovers both accounts' rent.
/// A non-zero `mandate_cap` pre-approves quotes whose release cap fits within
/// it until `mandate_expires_at`.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "createJob"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 2))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config")))]
#[cfg_attr(feature = "idl", codama(account(name = "job", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "vault", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer", signer)))]
#[cfg_attr(feature = "idl", codama(account(name = "customer_token", writable)))]
#[cfg_attr(
    feature = "idl",
    codama(account(name = "rent_payer", signer, writable))
)]
#[cfg_attr(feature = "idl", codama(account(name = "mint")))]
#[cfg_attr(feature = "idl", codama(account(name = "token_program")))]
#[cfg_attr(feature = "idl", codama(account(name = "system_program")))]
pub struct CreateJob {
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub job_id: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub budget: LeU64,
    pub job_kind: u8,
    pub adapter: u8,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub mandate_cap: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub mandate_expires_at: LeI64,
}

/// `ceil(amount * fee_bps / 10_000)`.
pub(crate) fn fee_reserve(amount: u64, fee_bps: u16) -> Result<u64> {
    mul(amount, u64::from(fee_bps))
        .and_then(|product| product.checked_add(crate::BASIS_POINTS - 1))
        .map(|product| product / crate::BASIS_POINTS)
        .ok_or_else(|| WillError::Overflow.into())
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, job_account, vault, customer, customer_token, rent_payer, mint, token_program, system_program, ..] =
        accounts
    else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &CreateJob = parse(args)?;
    let config = Config::load(config)?;
    require(config.paused == 0, WillError::Paused)?;
    check_signer(customer)?;
    check_payer(rent_payer)?;
    check_writable(customer_token)?;
    require(
        token_account_owner(customer_token, &config.mint)? == customer.address(),
        WillError::NotCustomer,
    )?;
    if mint.address() != &config.mint {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    check_address(system_program, &SYSTEM_PROGRAM_ID)?;

    let budget = args.budget.get();
    require(budget > 0, WillError::BadAmount)?;
    require(
        args.job_kind <= MAX_CODE && args.adapter <= MAX_CODE,
        WillError::KindOutOfRange,
    )?;
    let expires_at = now()?
        .checked_add(i64::from(config.job_timeout.get()))
        .ok_or(WillError::Overflow)?;
    require(
        args.mandate_cap.get() == 0 || args.mandate_expires_at.get() <= expires_at,
        WillError::BadAmount,
    )?;
    let fee_bps = config.fee_bps.get();
    let reserve = fee_reserve(budget, fee_bps)?;
    let total = budget.checked_add(reserve).ok_or(WillError::Overflow)?;

    let bump = init_pda(
        job_account,
        rent_payer,
        &ID,
        size_of::<Job>(),
        &[JOB_SEED, customer.address().as_ref(), args.job_id.bytes()],
    )?;
    let vault_bump = init_pda(
        vault,
        rent_payer,
        &TOKEN_PROGRAM_ID,
        TOKEN_ACCOUNT_LEN,
        &[VAULT_SEED, job_account.address().as_ref()],
    )?;
    token_initialize_account(vault, mint, job_account.address())?;
    token_transfer(customer_token, vault, customer, total, &[])?;

    // SAFETY: `job_account` was just created, zero-filled, with `size_of::<Job>()` bytes.
    let job = unsafe { &mut *(job_account.data_mut_ptr() as *mut Job) };
    job.tag = JOB_TAG;
    job.version = VERSION;
    job.status = status::FUNDED;
    job.bump = bump;
    job.vault_bump = vault_bump;
    job.job_kind = args.job_kind;
    job.adapter = args.adapter;
    job.fee_bps.set(fee_bps);
    job.customer = *customer.address();
    job.rent_payer = *rent_payer.address();
    job.job_id = args.job_id;
    job.budget = args.budget;
    job.fee_reserve.set(reserve);
    job.mandate_cap = args.mandate_cap;
    job.mandate_expires_at = args.mandate_expires_at;
    job.expires_at.set(expires_at);
    Ok(())
}
