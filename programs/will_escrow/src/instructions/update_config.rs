use {
    super::initialize_config::{funding_list, validate},
    crate::{
        error::{require, Error, Result, WillError},
        state::{Config, LeU16, LeU32},
        util::{check_signer, parse},
    },
    pinocchio::{AccountView, Address},
};

pub const DISCRIMINATOR: u8 = 1;

/// Admin-only: rotate keys and funding accounts, change the fee and
/// timeouts, or pause. The mint never changes. Trailing accounts: the new
/// 1-4 funding token accounts. Pausing blocks new jobs and releases only.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "updateConfig"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 1))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config", writable)))]
#[cfg_attr(feature = "idl", codama(account(name = "admin", signer)))]
#[cfg_attr(
    feature = "idl",
    codama(remaining_accounts(
        argument("funding"),
        docs = "Allowlisted USDC funding token accounts (1-4)."
    ))
)]
pub struct UpdateConfig {
    #[cfg_attr(feature = "idl", codama(type = number(u16)))]
    pub fee_bps: LeU16,
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub dispute_window: LeU32,
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub job_timeout: LeU32,
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub dispute_timeout: LeU32,
    pub paused: u8,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub admin: Address,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub operator: Address,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub treasury: Address,
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config_account, admin, funding @ ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &UpdateConfig = parse(args)?;
    let config = Config::load_mut(config_account)?;
    check_signer(admin)?;
    require(admin.address() == &config.admin, WillError::NotAdmin)?;
    require(args.paused <= 1, WillError::BadAmount)?;
    validate(
        args.fee_bps.get(),
        [
            args.dispute_window.get(),
            args.job_timeout.get(),
            args.dispute_timeout.get(),
        ],
        [&args.admin, &args.operator, &args.treasury],
    )?;
    let (funding_count, funding) = funding_list(funding, &config.mint)?;

    config.paused = args.paused;
    config.fee_bps = args.fee_bps;
    config.dispute_window = args.dispute_window;
    config.job_timeout = args.job_timeout;
    config.dispute_timeout = args.dispute_timeout;
    config.admin = args.admin;
    config.operator = args.operator;
    config.treasury = args.treasury;
    config.funding_count = funding_count;
    config.funding = funding;
    Ok(())
}
