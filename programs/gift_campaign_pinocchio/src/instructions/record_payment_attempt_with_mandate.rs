use {
    super::accounts,
    crate::{
        error::{require, GiftCampaignError, Result},
        events::{MandateConsumed, PaymentAttempted},
        mandate::{quote_terms_hash, validate_mandate_quote},
        state::{campaign_status, mandate_status, Campaign, Config, Mandate},
        util::{check_signer, emit, is_zero, now, parse},
    },
    pinocchio::AccountView,
};

#[repr(C)]
struct Args {
    terms_hash: [u8; 32],
    payment_attempt_hash: [u8; 32],
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
        campaign.status == campaign_status::APPROVED,
        GiftCampaignError::InvalidCampaignState,
    )?;
    require(
        !is_zero(&args.terms_hash) && !is_zero(&args.payment_attempt_hash),
        GiftCampaignError::ZeroHash,
    )?;
    let now = now()?;
    validate_mandate_quote(
        campaign_account.address(),
        mandate_account.address(),
        campaign,
        mandate,
        config,
        executor.address(),
        now,
    )?;
    require(
        args.terms_hash == mandate.approved_terms_hash
            && args.terms_hash == campaign.gift_hash
            && args.terms_hash
                == quote_terms_hash(
                    campaign_account.address(),
                    mandate_account.address(),
                    campaign,
                    mandate,
                    config,
                ),
        GiftCampaignError::TermsMismatch,
    )?;

    // One transaction consumes authorization and records intent before any external charge.
    // No instruction can reactivate/close this PDA, including after an uncertain attempt.
    let now_bytes = now.to_le_bytes();
    mandate.status = mandate_status::CONSUMED;
    mandate.consumed_at = now_bytes;
    campaign.payment_attempt_hash = args.payment_attempt_hash;
    campaign.payment_attempted_at = now_bytes;
    campaign.status = campaign_status::PAYMENT_ATTEMPTED;
    emit(&MandateConsumed {
        discriminator: MandateConsumed::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        mandate: *mandate_account.address(),
        terms_hash: args.terms_hash,
        payment_attempt_hash: args.payment_attempt_hash,
        consumed_at: now_bytes,
    });
    emit(&PaymentAttempted {
        discriminator: PaymentAttempted::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        quote_version: campaign.kind.quote_version,
        payment_attempt_hash: args.payment_attempt_hash,
        attempted_at: now_bytes,
    });
    Ok(())
}
