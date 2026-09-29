use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::QuoteApproved,
        state::{campaign_status, Campaign},
        util::{check_signer, emit, i64_le, now, parse},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    quote_version: [u8; 4],
    quote_hash: [u8; 32],
}

/// Accounts: `campaign` (mut), `sender` (signer).
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(accounts, [campaign_account, sender]);
    let args: &Args = parse(args)?;
    let campaign = Campaign::load_mut(campaign_account)?;
    check_signer(sender)?;

    require(!campaign.has_mandate(), GiftCampaignError::MandateRequired)?;
    require(
        sender.address() == &campaign.sender,
        GiftCampaignError::UnauthorizedSender,
    )?;
    require(
        campaign.status == campaign_status::QUOTED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require(
        args.quote_version == campaign.kind.quote_version
            && args.quote_hash == campaign.commitments.quote_hash,
        GiftCampaignError::QuoteMismatch,
    )?;
    require(
        now()? <= i64_le(&campaign.window.expires_at),
        GiftCampaignError::QuoteExpired,
    )?;

    campaign.gift_hash = args.quote_hash;
    campaign.status = campaign_status::APPROVED;
    emit(&QuoteApproved {
        discriminator: QuoteApproved::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        sender: campaign.sender,
        quote_version: args.quote_version,
        quote_hash: args.quote_hash,
        landed_total_minor: campaign.amounts.landed_total_minor,
    });
    Ok(())
}
