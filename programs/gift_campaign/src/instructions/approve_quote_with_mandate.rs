use crate::{
    constants::{CONFIG_SEED, MANDATE_SEED},
    errors::GiftCampaignError,
    events::MandateQuoteApproved,
    mandate::{quote_terms_hash, validate_mandate_quote},
    state::{Campaign, CampaignStatus, Config, Mandate},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ApproveQuoteWithMandate<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, seeds = [MANDATE_SEED, campaign.key().as_ref()], bump = mandate.bump,
        has_one = campaign @ GiftCampaignError::MandateMismatch)]
    pub mandate: Box<Account<'info, Mandate>>,
    pub executor: Signer<'info>,
}

pub fn handle_approve_quote_with_mandate(
    ctx: Context<ApproveQuoteWithMandate>,
    quote_version: u32,
    terms_hash: [u8; 32],
) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let mandate = &mut ctx.accounts.mandate;
    require!(
        campaign.status == CampaignStatus::Quoted,
        GiftCampaignError::InvalidCampaignState
    );
    require!(
        quote_version == campaign.quote_version,
        GiftCampaignError::QuoteMismatch
    );
    require!(terms_hash != [0; 32], GiftCampaignError::ZeroHash);
    validate_mandate_quote(
        campaign.key(),
        mandate.key(),
        campaign,
        mandate,
        &ctx.accounts.config,
        ctx.accounts.executor.key(),
        Clock::get()?.unix_timestamp,
    )?;
    require!(
        terms_hash
            == quote_terms_hash(
                campaign.key(),
                mandate.key(),
                campaign,
                mandate,
                &ctx.accounts.config
            ),
        GiftCampaignError::TermsMismatch
    );
    mandate.approved_terms_hash = terms_hash;
    campaign.gift_hash = terms_hash;
    campaign.status = CampaignStatus::Approved;
    emit!(MandateQuoteApproved {
        campaign: campaign.key(),
        mandate: mandate.key(),
        quote_version,
        terms_hash
    });
    Ok(())
}
