use {
    super::accounts,
    crate::{
        error::{require, Error, GiftCampaignError, Result},
        events::CampaignCreated,
        state::{Campaign, Config, CAMPAIGN_DISCRIMINATOR},
        util::{
            check_address, check_payer, check_token_account, emit, i64_le, init_pda, now, parse,
            token_initialize_account, token_transfer, u64_le, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID,
        },
        CAMPAIGN_SEED, ID, VAULT_SEED,
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    nonce: [u8; 8],
    budget: [u8; 8],
    expires_at: [u8; 8],
}

const TOKEN_ACCOUNT_LEN: usize = 165;

/// Accounts: `config`, `campaign` (init PDA), `vault` (init token PDA),
/// `sender` (mut signer), `sender_token` (mut), `mint`, `token_program`,
/// `system_program`.
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(
        accounts,
        [
            config,
            campaign,
            vault,
            sender,
            sender_token,
            mint,
            token_program,
            system_program
        ]
    );
    let args: &Args = parse(args)?;

    let config = Config::load(config)?;
    check_payer(sender)?;
    check_token_account(sender_token, mint.address(), sender.address())?;
    check_address(mint, &config.allowed_mint).map_err(|_| Error::INVALID_ACCOUNT_DATA)?;
    if !mint.owned_by(&TOKEN_PROGRAM_ID) {
        return Err(Error::INVALID_ACCOUNT_OWNER);
    }
    check_address(token_program, &TOKEN_PROGRAM_ID)?;
    check_address(system_program, &SYSTEM_PROGRAM_ID)?;

    let campaign_bump = init_pda(
        campaign,
        sender,
        &ID,
        size_of::<Campaign>(),
        &[CAMPAIGN_SEED, sender.address().as_ref(), &args.nonce],
    )?;
    let vault_bump = init_pda(
        vault,
        sender,
        &TOKEN_PROGRAM_ID,
        TOKEN_ACCOUNT_LEN,
        &[VAULT_SEED, campaign.address().as_ref()],
    )?;
    token_initialize_account(vault, mint, campaign.address())?;

    let budget = u64_le(&args.budget);
    require(budget > 0, GiftCampaignError::InvalidBudget)?;
    let now = now()?;
    require(
        i64_le(&args.expires_at) > now,
        GiftCampaignError::InvalidExpiry,
    )?;

    token_transfer(sender_token, vault, sender, budget, &[])?;

    // SAFETY: `campaign` was just created, zero-filled, with `size_of::<Campaign>()` bytes.
    let state = unsafe { &mut *(campaign.data_mut_ptr() as *mut Campaign) };
    state.discriminator = CAMPAIGN_DISCRIMINATOR;
    state.sender = *sender.address();
    state.nonce = args.nonce;
    state.budget = args.budget;
    state.created_at = now.to_le_bytes();
    state.expires_at = args.expires_at;
    state.vault_bump = vault_bump;
    state.bump = campaign_bump;

    emit(&CampaignCreated {
        discriminator: CampaignCreated::DISCRIMINATOR,
        campaign: *campaign.address(),
        sender: state.sender,
        nonce: args.nonce,
        budget: args.budget,
        expires_at: args.expires_at,
    });
    Ok(())
}
