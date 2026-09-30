use {
    crate::{
        error::{require, Error, Result, WillError},
        state::{Config, LeU16, LeU32, CONFIG_SEED, CONFIG_TAG, VERSION},
        util::{
            check_address, check_mint, check_payer, init_pda, parse, token_account_owner,
            LOADER_V3_ID, SYSTEM_PROGRAM_ID,
        },
        ID, MAX_FEE_BPS, PROGRAM_DATA,
    },
    pinocchio::{AccountView, Address},
};

pub const DISCRIMINATOR: u8 = 0;

/// Creates the singleton config. Only the program's upgrade authority may
/// call it, and only once. Trailing accounts: 1-4 allowlisted funding token
/// accounts of `mint`.
#[repr(C)]
#[cfg_attr(feature = "idl", derive(codama::CodamaInstruction))]
#[cfg_attr(feature = "idl", codama(name = "initializeConfig"))]
#[cfg_attr(
    feature = "idl",
    codama(field("discriminator", number(u8), default_value = 0))
)]
#[cfg_attr(feature = "idl", codama(discriminator(field = "discriminator")))]
#[cfg_attr(feature = "idl", codama(account(name = "config", writable)))]
#[cfg_attr(
    feature = "idl",
    codama(account(name = "upgrade_authority", signer, writable))
)]
#[cfg_attr(feature = "idl", codama(account(name = "program_data")))]
#[cfg_attr(feature = "idl", codama(account(name = "mint")))]
#[cfg_attr(feature = "idl", codama(account(name = "system_program")))]
#[cfg_attr(
    feature = "idl",
    codama(remaining_accounts(
        argument("funding"),
        docs = "Allowlisted USDC funding token accounts (1-4)."
    ))
)]
pub struct InitializeConfig {
    #[cfg_attr(feature = "idl", codama(type = number(u16)))]
    pub fee_bps: LeU16,
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub dispute_window: LeU32,
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub job_timeout: LeU32,
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub dispute_timeout: LeU32,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub admin: Address,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub operator: Address,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub treasury: Address,
}

/// Loader-v3 `ProgramData` header (bincode): variant 3, slot, optional authority.
#[repr(C)]
struct ProgramDataHeader {
    variant: [u8; 4],
    slot: [u8; 8],
    has_authority: u8,
    authority: Address,
}

/// `authority` signed and is the upgrade authority recorded in *this*
/// program's ProgramData account (never another program's).
fn check_upgrade_authority(program_data: &AccountView, authority: &AccountView) -> Result {
    let valid = authority.is_signer()
        && program_data.address() == &PROGRAM_DATA
        && program_data.owned_by(&LOADER_V3_ID)
        && program_data.data_len() >= size_of::<ProgramDataHeader>()
        && {
            // SAFETY: length checked; the header has alignment 1.
            let header = unsafe { &*(program_data.data_ptr() as *const ProgramDataHeader) };
            header.variant == [3, 0, 0, 0]
                && header.has_authority == 1
                && &header.authority == authority.address()
        };
    require(valid, WillError::NotUpgradeAuthority)
}

/// Shared by initialize and update: fee within bounds, non-zero timeouts and
/// non-zero keys.
pub(crate) fn validate(fee_bps: u16, timeouts: [u32; 3], keys: [&Address; 3]) -> Result {
    require(
        fee_bps <= MAX_FEE_BPS
            && timeouts.iter().all(|seconds| *seconds > 0)
            && keys.iter().all(|key| **key != Address::default()),
        WillError::BadAmount,
    )
}

/// 1-4 initialized token accounts of `mint`, as a fixed allowlist.
pub(crate) fn funding_list(funding: &[AccountView], mint: &Address) -> Result<(u8, [Address; 4])> {
    require(
        (1..=4).contains(&funding.len()),
        WillError::FundingNotAllowed,
    )?;
    let mut list = [Address::default(); 4];
    for (slot, account) in list.iter_mut().zip(funding) {
        token_account_owner(account, mint)
            .map_err(|_| Error::from(WillError::FundingNotAllowed))?;
        *slot = *account.address();
    }
    Ok((funding.len() as u8, list))
}

pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    let [config, authority, program_data, mint, system_program, funding @ ..] = accounts else {
        return Err(Error::NOT_ENOUGH_ACCOUNT_KEYS);
    };
    let args: &InitializeConfig = parse(args)?;
    check_payer(authority)?;
    check_upgrade_authority(program_data, authority)?;
    check_mint(mint)?;
    check_address(system_program, &SYSTEM_PROGRAM_ID)?;
    validate(
        args.fee_bps.get(),
        [
            args.dispute_window.get(),
            args.job_timeout.get(),
            args.dispute_timeout.get(),
        ],
        [&args.admin, &args.operator, &args.treasury],
    )?;
    let (funding_count, funding) = funding_list(funding, mint.address())?;
    let bump = init_pda(config, authority, &ID, size_of::<Config>(), &[CONFIG_SEED])?;

    // SAFETY: `config` was just created with `size_of::<Config>()` bytes.
    let state = unsafe { &mut *(config.data_mut_ptr() as *mut Config) };
    *state = Config {
        tag: CONFIG_TAG,
        version: VERSION,
        bump,
        paused: 0,
        fee_bps: args.fee_bps,
        dispute_window: args.dispute_window,
        job_timeout: args.job_timeout,
        dispute_timeout: args.dispute_timeout,
        admin: args.admin,
        operator: args.operator,
        treasury: args.treasury,
        mint: *mint.address(),
        funding_count,
        funding,
    };
    Ok(())
}
