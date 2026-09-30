use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::MandateRevoked,
        state::{mandate_status, Campaign, Mandate},
        util::{check_signer, emit},
    },
    pinocchio::AccountView,
};

/// Accounts: `campaign` (`has_one = sender`), `mandate` (mut PDA, `has_one =
/// campaign`, `has_one = sender`, `campaign.mandate == mandate`), `sender` (signer).
pub fn process(accounts: &mut [AccountView], _args: &[u8]) -> Result {
    accounts!(accounts, [campaign_account, mandate_account, sender]);
    let campaign = Campaign::load(campaign_account)?;
    let mandate = Mandate::load(mandate_account)?;
    check_signer(sender)?;

    require(
        sender.address() == &campaign.sender,
        GiftCampaignError::UnauthorizedSender,
    )?;
    mandate.check_pda(mandate_account, campaign_account)?;
    require(
        mandate.parties.campaign == *campaign_account.address(),
        GiftCampaignError::MandateMismatch,
    )?;
    require(
        sender.address() == &mandate.parties.sender,
        GiftCampaignError::UnauthorizedSender,
    )?;
    require(
        campaign.mandate == *mandate_account.address(),
        GiftCampaignError::MandateMismatch,
    )?;
    require(
        mandate.status == mandate_status::ACTIVE,
        GiftCampaignError::InactiveMandate,
    )?;

    mandate.status = mandate_status::REVOKED;
    emit(&MandateRevoked {
        discriminator: MandateRevoked::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        mandate: *mandate_account.address(),
    });
    Ok(())
}
