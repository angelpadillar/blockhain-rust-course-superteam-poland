use anchor_lang::prelude::*;

use crate::{
    errors::GiftCampaignError,
    events::GiftApproved,
    state::{Campaign, CampaignStatus},
};

#[derive(Accounts)]
pub struct ApproveGift<'info> {
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub sender: Signer<'info>,
}

pub fn handle_approve_gift(ctx: Context<ApproveGift>, gift_hash: [u8; 32]) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.sender.key(),
        ctx.accounts.campaign.sender,
        GiftCampaignError::UnauthorizedSender
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::Researched,
        GiftCampaignError::InvalidCampaignState
    );
    require!(gift_hash != [0; 32], GiftCampaignError::ZeroHash);

    let campaign = &mut ctx.accounts.campaign;
    campaign.gift_hash = gift_hash;
    campaign.status = CampaignStatus::Approved;

    emit!(GiftApproved {
        campaign: campaign.key(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        gift_hash,
    });

    Ok(())
}
