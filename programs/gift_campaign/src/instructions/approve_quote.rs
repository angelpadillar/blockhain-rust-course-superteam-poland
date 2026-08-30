use anchor_lang::prelude::*;

use crate::{
    errors::GiftCampaignError,
    events::QuoteApproved,
    state::{Campaign, CampaignStatus},
};

#[derive(Accounts)]
pub struct ApproveQuote<'info> {
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub sender: Signer<'info>,
}

pub fn handle_approve_quote(
    ctx: Context<ApproveQuote>,
    quote_version: u32,
    quote_hash: [u8; 32],
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.sender.key(),
        ctx.accounts.campaign.sender,
        GiftCampaignError::UnauthorizedSender
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::Quoted,
        GiftCampaignError::InvalidCampaignState
    );
    require!(
        quote_version == ctx.accounts.campaign.quote_version
            && quote_hash == ctx.accounts.campaign.quote_hash,
        GiftCampaignError::QuoteMismatch
    );
    require!(
        Clock::get()?.unix_timestamp <= ctx.accounts.campaign.quote_expires_at,
        GiftCampaignError::QuoteExpired
    );

    let campaign = &mut ctx.accounts.campaign;
    campaign.gift_hash = quote_hash;
    campaign.status = CampaignStatus::Approved;
    emit!(QuoteApproved {
        campaign: campaign.key(),
        sender: campaign.sender,
        quote_version,
        quote_hash,
        landed_total_minor: campaign.landed_total_minor,
    });
    Ok(())
}
