use {
    crate::{
        error::Result,
        state::{Campaign, Config},
        util::{check_distinct, check_pda, check_token_account},
        VAULT_SEED,
    },
    pinocchio::AccountView,
};

/// The escrow accounts shared by `settle_fulfillment`, `confirm_delivery` and
/// `cancel`:
///
/// ```ignore
/// #[account(mut, seeds = [VAULT_SEED, campaign.key()], bump = campaign.vault_bump,
///     token::mint = config.allowed_mint, token::authority = campaign)]
/// pub vault: Account<'info, TokenAccount>,
/// #[account(mut, token::mint = config.allowed_mint, token::authority = campaign.sender)]
/// pub sender_token: Account<'info, TokenAccount>,
/// ```
///
/// Like Anchor's duplicate-mutable-account check, the vault may not also fill
/// another writable token slot; callers check the slots they add.
pub fn load_vault(
    vault: &AccountView,
    campaign_account: &AccountView,
    campaign: &Campaign,
    config: &Config,
    sender_token: &AccountView,
) -> Result {
    check_pda(
        vault,
        [
            VAULT_SEED,
            campaign_account.address().as_ref(),
            &[campaign.vault_bump],
            &[],
        ],
    )?;
    check_token_account(vault, &config.allowed_mint, campaign_account.address())?;
    check_token_account(sender_token, &config.allowed_mint, &campaign.sender)?;
    check_distinct(vault, sender_token)
}
