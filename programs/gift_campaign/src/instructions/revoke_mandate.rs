use crate::{
    constants::MANDATE_SEED,
    errors::GiftCampaignError,
    events::MandateRevoked,
    state::{Campaign, Mandate, MandateStatus},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    #[account(has_one = sender @ GiftCampaignError::UnauthorizedSender)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, seeds = [MANDATE_SEED, campaign.key().as_ref()], bump = mandate.bump,
        has_one = campaign @ GiftCampaignError::MandateMismatch,
        has_one = sender @ GiftCampaignError::UnauthorizedSender,
        constraint = campaign.mandate == mandate.key() @ GiftCampaignError::MandateMismatch)]
    pub mandate: Box<Account<'info, Mandate>>,
    pub sender: Signer<'info>,
}

pub fn handle_revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
    require!(
        ctx.accounts.mandate.status == MandateStatus::Active,
        GiftCampaignError::InactiveMandate
    );
    ctx.accounts.mandate.status = MandateStatus::Revoked;
    emit!(MandateRevoked {
        campaign: ctx.accounts.campaign.key(),
        mandate: ctx.accounts.mandate.key()
    });
    Ok(())
}
