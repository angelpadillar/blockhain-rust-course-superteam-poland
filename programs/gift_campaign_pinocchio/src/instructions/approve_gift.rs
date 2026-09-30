use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::GiftApproved,
        state::{campaign_status, Campaign},
        util::{check_signer, emit, parse, require_hash},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    gift_hash: [u8; 32],
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
        campaign.status == campaign_status::RESEARCHED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.gift_hash)?;

    campaign.gift_hash = args.gift_hash;
    campaign.status = campaign_status::APPROVED;
    emit(&GiftApproved {
        discriminator: GiftApproved::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        gift_hash: args.gift_hash,
    });
    Ok(())
}
