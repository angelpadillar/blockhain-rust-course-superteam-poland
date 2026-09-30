use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::ResearchSubmitted,
        state::{campaign_status, Campaign, Config},
        util::{check_signer, emit, parse, require_hash},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    research_hash: [u8; 32],
}

/// Accounts: `config`, `campaign` (mut), `research_oracle` (signer).
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(accounts, [config, campaign_account, research_oracle]);
    let args: &Args = parse(args)?;
    let config = Config::load(config)?;
    let campaign = Campaign::load_mut(campaign_account)?;
    check_signer(research_oracle)?;

    require(
        research_oracle.address() == &config.research_oracle,
        GiftCampaignError::UnauthorizedResearchOracle,
    )?;
    require(
        campaign.status == campaign_status::FUNDED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require_hash(&args.research_hash)?;

    campaign.research_hash = args.research_hash;
    campaign.status = campaign_status::RESEARCHED;
    emit(&ResearchSubmitted {
        discriminator: ResearchSubmitted::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        sender: campaign.sender,
        nonce: campaign.nonce,
        research_hash: args.research_hash,
    });
    Ok(())
}
