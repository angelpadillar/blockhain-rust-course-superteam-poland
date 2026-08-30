use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    errors::GiftCampaignError,
    events::PurchaseConfirmed,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct RecordPurchase<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub fulfillment_oracle: Signer<'info>,
}

pub fn handle_record_purchase(
    ctx: Context<RecordPurchase>,
    purchase_hash: [u8; 32],
    order_id_hash: [u8; 32],
    currency: [u8; 3],
    charged_amount_minor: u64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.fulfillment_oracle.key(),
        ctx.accounts.config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle
    );
    require!(
        ctx.accounts.campaign.status == CampaignStatus::PaymentAuthenticated,
        GiftCampaignError::InvalidCampaignState
    );
    for hash in [purchase_hash, order_id_hash] {
        require!(hash != [0; 32], GiftCampaignError::ZeroHash);
    }
    require!(
        currency == ctx.accounts.campaign.charge_currency
            && charged_amount_minor == ctx.accounts.campaign.authenticated_amount_minor
            && charged_amount_minor == ctx.accounts.campaign.quoted_charge_amount_minor,
        GiftCampaignError::PaymentMismatch
    );

    let now = Clock::get()?.unix_timestamp;
    let campaign = &mut ctx.accounts.campaign;
    campaign.purchase_hash = purchase_hash;
    campaign.order_id_hash = order_id_hash;
    campaign.charged_amount_minor = charged_amount_minor;
    campaign.purchased_at = now;
    campaign.status = CampaignStatus::Purchased;
    emit!(PurchaseConfirmed {
        campaign: campaign.key(),
        purchase_hash,
        order_id_hash,
        currency,
        charged_amount_minor,
        purchased_at: now,
    });
    Ok(())
}
