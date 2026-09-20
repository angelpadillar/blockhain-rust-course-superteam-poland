use crate::{
    constants::{CONFIG_SEED, MANDATE_SEED},
    errors::GiftCampaignError,
    events::{MandateConsumed, PaymentAttempted},
    mandate::{quote_terms_hash, validate_mandate_quote},
    state::{Campaign, CampaignStatus, Config, Mandate, MandateStatus},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RecordPaymentAttemptWithMandate<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    #[account(mut, seeds = [MANDATE_SEED, campaign.key().as_ref()], bump = mandate.bump,
        has_one = campaign @ GiftCampaignError::MandateMismatch)]
    pub mandate: Box<Account<'info, Mandate>>,
    pub executor: Signer<'info>,
}

pub fn handle_record_payment_attempt_with_mandate(
    ctx: Context<RecordPaymentAttemptWithMandate>,
    terms_hash: [u8; 32],
    payment_attempt_hash: [u8; 32],
) -> Result<()> {
    let campaign = &mut ctx.accounts.campaign;
    let mandate = &mut ctx.accounts.mandate;
    require!(
        campaign.status == CampaignStatus::Approved,
        GiftCampaignError::InvalidCampaignState
    );
    require!(
        terms_hash != [0; 32] && payment_attempt_hash != [0; 32],
        GiftCampaignError::ZeroHash
    );
    let now = Clock::get()?.unix_timestamp;
    validate_mandate_quote(
        campaign.key(),
        mandate.key(),
        campaign,
        mandate,
        &ctx.accounts.config,
        ctx.accounts.executor.key(),
        now,
    )?;
    require!(
        terms_hash == mandate.approved_terms_hash
            && terms_hash == campaign.gift_hash
            && terms_hash
                == quote_terms_hash(
                    campaign.key(),
                    mandate.key(),
                    campaign,
                    mandate,
                    &ctx.accounts.config
                ),
        GiftCampaignError::TermsMismatch
    );
    // One transaction consumes authorization and records intent before any external charge.
    // No instruction can reactivate/close this PDA, including after an uncertain attempt.
    mandate.status = MandateStatus::Consumed;
    mandate.consumed_at = now;
    campaign.payment_attempt_hash = payment_attempt_hash;
    campaign.payment_attempted_at = now;
    campaign.status = CampaignStatus::PaymentAttempted;
    emit!(MandateConsumed {
        campaign: campaign.key(),
        mandate: mandate.key(),
        terms_hash,
        payment_attempt_hash,
        consumed_at: now
    });
    emit!(PaymentAttempted {
        campaign: campaign.key(),
        quote_version: campaign.quote_version,
        payment_attempt_hash,
        attempted_at: now
    });
    Ok(())
}
