use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::{
    constants::{CAMPAIGN_SEED, CONFIG_SEED, VAULT_SEED},
    errors::GiftCampaignError,
    events::CampaignCancelled,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.sender.as_ref(), &campaign.nonce.to_le_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.key().as_ref()],
        bump = campaign.vault_bump,
        token::mint = config.allowed_mint,
        token::authority = campaign
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = config.allowed_mint,
        token::authority = campaign.sender
    )]
    pub sender_token: Account<'info, TokenAccount>,
    pub canceller: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    require!(
        ctx.accounts.campaign.status.can_cancel(),
        GiftCampaignError::InvalidCampaignState
    );

    let now = Clock::get()?.unix_timestamp;
    let is_sender = ctx.accounts.canceller.key() == ctx.accounts.campaign.sender;
    let is_expired_oracle = ctx.accounts.canceller.key() == ctx.accounts.config.delivery_oracle
        && now > ctx.accounts.campaign.expires_at;
    require!(
        (is_sender && ctx.accounts.campaign.status.sender_can_cancel()) || is_expired_oracle,
        GiftCampaignError::UnauthorizedCancellation
    );

    let sender = ctx.accounts.campaign.sender;
    let nonce_bytes = ctx.accounts.campaign.nonce.to_le_bytes();
    let campaign_bump = [ctx.accounts.campaign.bump];
    let signer_seeds: &[&[u8]] = &[
        CAMPAIGN_SEED,
        sender.as_ref(),
        nonce_bytes.as_ref(),
        campaign_bump.as_ref(),
    ];
    let signer = &[signer_seeds];
    let refund = ctx.accounts.vault.amount;

    if refund > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.sender_token.to_account_info(),
                    authority: ctx.accounts.campaign.to_account_info(),
                },
                signer,
            ),
            refund,
        )?;
    }

    let campaign = &mut ctx.accounts.campaign;
    campaign.status = CampaignStatus::Cancelled;

    emit!(CampaignCancelled {
        campaign: campaign.key(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        refund,
    });

    Ok(())
}
