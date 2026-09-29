use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::PurchaseConfirmed,
        state::{campaign_status, Campaign, Config},
        util::{check_signer, emit, now, parse, require_hash},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    purchase_hash: [u8; 32],
    order_id_hash: [u8; 32],
    currency: [u8; 3],
    charged_amount_minor: [u8; 8],
}

/// Accounts: `config`, `campaign` (mut), `fulfillment_oracle` (signer).
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(accounts, [config, campaign_account, fulfillment_oracle]);
    let args: &Args = parse(args)?;
    let config = Config::load(config)?;
    let campaign = Campaign::load_mut(campaign_account)?;
    check_signer(fulfillment_oracle)?;

    require(
        fulfillment_oracle.address() == &config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle,
    )?;
    require(
        campaign.status == campaign_status::PAYMENT_AUTHENTICATED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.purchase_hash)?;
    require_hash(&args.order_id_hash)?;
    require(
        args.currency == campaign.currencies.charge_currency
            && args.charged_amount_minor == campaign.authenticated_amount_minor
            && args.charged_amount_minor == campaign.amounts.quoted_charge_amount_minor,
        GiftCampaignError::PaymentMismatch,
    )?;

    let now_bytes = now()?.to_le_bytes();
    campaign.purchase_hash = args.purchase_hash;
    campaign.order_id_hash = args.order_id_hash;
    campaign.charged_amount_minor = args.charged_amount_minor;
    campaign.purchased_at = now_bytes;
    campaign.status = campaign_status::PURCHASED;
    emit(&PurchaseConfirmed {
        discriminator: PurchaseConfirmed::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        purchase_hash: args.purchase_hash,
        order_id_hash: args.order_id_hash,
        currency: args.currency,
        charged_amount_minor: args.charged_amount_minor,
        purchased_at: now_bytes,
    });
    Ok(())
}
