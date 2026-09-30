use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        state::{Config, CONFIG_DISCRIMINATOR},
        util::{
            check_address, check_mint, check_payer, check_system_account, init_pda, parse,
            SYSTEM_PROGRAM_ID,
        },
        CONFIG_SEED, ID, MAX_FEE_BPS,
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    fee_bps: [u8; 2],
}

/// Accounts: `config` (init PDA), `authority` (mut signer), `treasury`,
/// `research_oracle`, `delivery_oracle` (system accounts), `allowed_mint`,
/// `system_program`.
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(
        accounts,
        [
            config,
            authority,
            treasury,
            research_oracle,
            delivery_oracle,
            allowed_mint,
            system_program
        ]
    );
    let args: &Args = parse(args)?;

    check_payer(authority)?;
    check_system_account(treasury)?;
    check_system_account(research_oracle)?;
    check_system_account(delivery_oracle)?;
    check_mint(allowed_mint)?;
    check_address(system_program, &SYSTEM_PROGRAM_ID)?;
    let bump = init_pda(config, authority, &ID, size_of::<Config>(), &[CONFIG_SEED])?;

    require(
        u16::from_le_bytes(args.fee_bps) <= MAX_FEE_BPS,
        GiftCampaignError::FeeTooHigh,
    )?;

    // SAFETY: `config` was just created with `size_of::<Config>()` bytes.
    let state = unsafe { &mut *(config.data_mut_ptr() as *mut Config) };
    state.discriminator = CONFIG_DISCRIMINATOR;
    state.authority = *authority.address();
    state.treasury = *treasury.address();
    state.research_oracle = *research_oracle.address();
    state.delivery_oracle = *delivery_oracle.address();
    state.allowed_mint = *allowed_mint.address();
    state.fee_bps = args.fee_bps;
    state.bump = bump;
    Ok(())
}
