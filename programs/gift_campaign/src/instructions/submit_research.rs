use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    errors::GiftCampaignError,
    events::ResearchSubmitted,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct SubmitResearch<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub research_oracle: Signer<'info>,
}

pub fn handle_submit_research(ctx: Context<SubmitResearch>, research_hash: [u8; 32]) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.research_oracle.key(),
        ctx.accounts.config.research_oracle,
        GiftCampaignError::UnauthorizedResearchOracle
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::Funded,
        GiftCampaignError::InvalidCampaignState
    );
    require!(research_hash != [0; 32], GiftCampaignError::ZeroHash);

    let campaign = &mut ctx.accounts.campaign;
    campaign.research_hash = research_hash;
    campaign.status = CampaignStatus::Researched;

    emit!(ResearchSubmitted {
        campaign: campaign.key(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        research_hash,
    });

    Ok(())
}
