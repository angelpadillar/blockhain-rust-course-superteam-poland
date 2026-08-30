use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    errors::GiftCampaignError,
    events::PaymentAttempted,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct RecordPaymentAttempt<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub fulfillment_oracle: Signer<'info>,
}

pub fn handle_record_payment_attempt(
    ctx: Context<RecordPaymentAttempt>,
    quote_version: u32,
    quote_hash: [u8; 32],
    payment_attempt_hash: [u8; 32],
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.fulfillment_oracle.key(),
        ctx.accounts.config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::Approved,
        GiftCampaignError::InvalidCampaignState
    );
    require!(payment_attempt_hash != [0; 32], GiftCampaignError::ZeroHash);
    require!(
        quote_version == ctx.accounts.campaign.quote_version
            && quote_hash == ctx.accounts.campaign.quote_hash,
        GiftCampaignError::QuoteMismatch
    );
    let now = Clock::get()?.unix_timestamp;
    require!(
        now <= ctx.accounts.campaign.quote_expires_at && now <= ctx.accounts.campaign.expires_at,
        GiftCampaignError::QuoteExpired
    );

    let campaign = &mut ctx.accounts.campaign;
    campaign.payment_attempt_hash = payment_attempt_hash;
    campaign.payment_attempted_at = now;
    campaign.status = CampaignStatus::PaymentAttempted;
    emit!(PaymentAttempted {
        campaign: campaign.key(),
        quote_version,
        payment_attempt_hash,
        attempted_at: now,
    });
    Ok(())
}
