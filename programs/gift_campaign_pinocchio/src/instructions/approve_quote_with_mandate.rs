use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::MandateQuoteApproved,
        mandate::{quote_terms_hash, validate_mandate_quote},
        state::{campaign_status, Campaign, Config, Mandate},
        util::{check_signer, emit, now, parse, require_hash},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    quote_version: [u8; 4],
    terms_hash: [u8; 32],
}

/// Accounts: `config`, `campaign` (mut), `mandate` (mut PDA, `has_one =
/// campaign`), `executor` (signer).
pub fn process(accounts: &mut [AccountView], args: &[u8]) -> Result {
    accounts!(
        accounts,
        [config, campaign_account, mandate_account, executor]
    );
    let args: &Args = parse(args)?;
    let config = Config::load(config)?;
    let campaign = Campaign::load_mut(campaign_account)?;
    let mandate = Mandate::load(mandate_account)?;
    check_signer(executor)?;
    mandate.check_pda(mandate_account, campaign_account)?;
    require(
        mandate.parties.campaign == *campaign_account.address(),
        GiftCampaignError::MandateMismatch,
    )?;

    require(
        campaign.status == campaign_status::QUOTED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require(
        args.quote_version == campaign.kind.quote_version,
        GiftCampaignError::QuoteMismatch,
    )?;
    require_hash(&args.terms_hash)?;
    validate_mandate_quote(
        campaign_account.address(),
        mandate_account.address(),
        campaign,
        mandate,
        config,
        executor.address(),
        now()?,
    )?;
    require(
        args.terms_hash
            == quote_terms_hash(
                campaign_account.address(),
                mandate_account.address(),
                campaign,
                mandate,
                config,
            ),
        GiftCampaignError::TermsMismatch,
    )?;

    mandate.approved_terms_hash = args.terms_hash;
    campaign.gift_hash = args.terms_hash;
    campaign.status = campaign_status::APPROVED;
    emit(&MandateQuoteApproved {
        discriminator: MandateQuoteApproved::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        mandate: *mandate_account.address(),
        quote_version: args.quote_version,
        terms_hash: args.terms_hash,
    });
    Ok(())
}
