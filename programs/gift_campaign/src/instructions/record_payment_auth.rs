use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    errors::GiftCampaignError,
    events::PaymentAuthenticated,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct RecordPaymentAuth<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub fulfillment_oracle: Signer<'info>,
}

pub fn handle_record_payment_auth(
    ctx: Context<RecordPaymentAuth>,
    payment_auth_hash: [u8; 32],
    currency: [u8; 3],
    authenticated_amount_minor: u64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.fulfillment_oracle.key(),
        ctx.accounts.config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::PaymentAttempted,
        GiftCampaignError::InvalidCampaignState
    );
    require!(payment_auth_hash != [0; 32], GiftCampaignError::ZeroHash);
    require!(
        currency == ctx.accounts.campaign.charge_currency
            && authenticated_amount_minor == ctx.accounts.campaign.quoted_charge_amount_minor,
        GiftCampaignError::PaymentMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let campaign = &mut ctx.accounts.campaign;
    campaign.payment_auth_hash = payment_auth_hash;
    campaign.authenticated_amount_minor = authenticated_amount_minor;
    campaign.payment_authenticated_at = now;
    campaign.status = CampaignStatus::PaymentAuthenticated;
    emit!(PaymentAuthenticated {
        campaign: campaign.key(),
        payment_auth_hash,
        currency,
        authenticated_amount_minor,
        authenticated_at: now,
    });
    Ok(())
}
