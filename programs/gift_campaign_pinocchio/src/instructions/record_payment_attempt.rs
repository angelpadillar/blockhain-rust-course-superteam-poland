use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::PaymentAttempted,
        state::{campaign_status, Campaign, Config},
        util::{check_signer, emit, i64_le, now, parse, require_hash},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    quote_version: [u8; 4],
    quote_hash: [u8; 32],
    payment_attempt_hash: [u8; 32],
}

/// Accounts: `config`, `campaign` (mut), `fulfillment_oracle` (signer).
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(accounts, [config, campaign_account, fulfillment_oracle]);
    let args: &Args = parse(args)?;
    let config = Config::load(config)?;
    let campaign = Campaign::load_mut(campaign_account)?;
    check_signer(fulfillment_oracle)?;

    require(!campaign.has_mandate(), GiftCampaignError::MandateRequired)?;
    require(
        fulfillment_oracle.address() == &config.delivery_oracle,
        GiftCampaignError::UnauthorizedFulfillmentOracle,
    )?;
    require(
        campaign.status == campaign_status::APPROVED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.payment_attempt_hash)?;
    require(
        args.quote_version == campaign.kind.quote_version
            && args.quote_hash == campaign.commitments.quote_hash,
        GiftCampaignError::QuoteMismatch,
    )?;
    let now = now()?;
    require(
        now <= i64_le(&campaign.window.expires_at) && now <= i64_le(&campaign.expires_at),
        GiftCampaignError::QuoteExpired,
    )?;

    let now_bytes = now.to_le_bytes();
    campaign.payment_attempt_hash = args.payment_attempt_hash;
    campaign.payment_attempted_at = now_bytes;
    campaign.status = campaign_status::PAYMENT_ATTEMPTED;
    emit(&PaymentAttempted {
        discriminator: PaymentAttempted::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        quote_version: args.quote_version,
        payment_attempt_hash: args.payment_attempt_hash,
        attempted_at: now_bytes,
    });
    Ok(())
}
