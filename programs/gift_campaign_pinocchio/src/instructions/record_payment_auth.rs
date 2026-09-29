use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::PaymentAuthenticated,
        state::{campaign_status, Campaign, Config},
        util::{check_signer, emit, now, parse, require_hash},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    payment_auth_hash: [u8; 32],
    currency: [u8; 3],
    authenticated_amount_minor: [u8; 8],
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
        campaign.status == campaign_status::PAYMENT_ATTEMPTED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.payment_auth_hash)?;
    require(
        args.currency == campaign.currencies.charge_currency
            && args.authenticated_amount_minor == campaign.amounts.quoted_charge_amount_minor,
        GiftCampaignError::PaymentMismatch,
    )?;

    let now_bytes = now()?.to_le_bytes();
    campaign.payment_auth_hash = args.payment_auth_hash;
    campaign.authenticated_amount_minor = args.authenticated_amount_minor;
    campaign.payment_authenticated_at = now_bytes;
    campaign.status = campaign_status::PAYMENT_AUTHENTICATED;
    emit(&PaymentAuthenticated {
        discriminator: PaymentAuthenticated::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        payment_auth_hash: args.payment_auth_hash,
        currency: args.currency,
        authenticated_amount_minor: args.authenticated_amount_minor,
        authenticated_at: now_bytes,
    });
    Ok(())
}
