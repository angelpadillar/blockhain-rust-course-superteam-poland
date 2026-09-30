use {
    super::accounts,
    crate::{
        error::{require, Error, GiftCampaignError, Result},
        events::QuoteSubmitted,
        state::{
            campaign_status, Campaign, Config, QuoteAmounts, QuoteCommitments, QuoteCurrencies,
            QuoteKind, QuoteWindow,
        },
        util::{
            check_signer, emit, escrow_debit, i64_le, is_supported_currency, now, parse,
            require_hash, u64_le,
        },
    },
    pinocchio::AccountView,
};

/// The Anchor argument order happens to be the campaign's quote field groups
/// in sequence, so each group is copied into the account whole.
#[repr(C)]
struct Args {
    kind: QuoteKind,
    commitments: QuoteCommitments,
    currencies: QuoteCurrencies,
    amounts: QuoteAmounts,
    window: QuoteWindow,
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
        matches!(
            campaign.status,
            campaign_status::FUNDED | campaign_status::RESEARCHED
        ),
        GiftCampaignError::InvalidCampaignState,
    )?;
    let kind = &args.kind;
    require(
        u32::from_le_bytes(kind.quote_version) > 0 && kind.job_kind <= 3 && kind.adapter <= 3,
        GiftCampaignError::QuoteMismatch,
    )?;
    let commitments = &args.commitments;
    require_hash(&commitments.spec_hash)?;
    require_hash(&commitments.quote_hash)?;
    require_hash(&commitments.merchant_hash)?;
    let currencies = &args.currencies;
    require(
        is_supported_currency(&currencies.currency, currencies.currency_exponent)
            && is_supported_currency(
                &currencies.charge_currency,
                currencies.charge_currency_exponent,
            ),
        GiftCampaignError::UnsupportedCurrency,
    )?;

    let amounts = &args.amounts;
    let landed_total = u64_le(&amounts.landed_total_minor);
    let calculated_total = [
        &amounts.small_order_fee_minor,
        &amounts.service_fee_minor,
        &amounts.delivery_fee_minor,
        &amounts.tip_minor,
        &amounts.other_fees_minor,
    ]
    .into_iter()
    .try_fold(u64_le(&amounts.item_subtotal_minor), |total, part| {
        total.checked_add(u64_le(part))
    })
    .ok_or(Error::from(GiftCampaignError::ArithmeticOverflow))?;
    require(
        landed_total > 0 && calculated_total == landed_total,
        GiftCampaignError::QuoteTotalMismatch,
    )?;
    let max_total = u64_le(&amounts.max_total_minor);
    require(
        max_total > 0 && landed_total <= max_total,
        GiftCampaignError::QuoteExceedsMaximum,
    )?;
    let settlement_amount = u64_le(&amounts.settlement_amount);
    require(
        settlement_amount > 0
            && u64_le(&amounts.quoted_charge_amount_minor) > 0
            && u64_le(&amounts.settlement_units_per_charge_unit_micros) > 0,
        GiftCampaignError::InvalidBudget,
    )?;

    let quote_expires_at = i64_le(&args.window.expires_at);
    require(
        i64_le(&args.window.captured_at) <= quote_expires_at
            && quote_expires_at > now()?
            && quote_expires_at <= i64_le(&campaign.expires_at),
        GiftCampaignError::QuoteExpired,
    )?;
    require(
        escrow_debit(settlement_amount, &config.fee_bps)? <= u64_le(&campaign.budget),
        GiftCampaignError::InsufficientEscrowBudget,
    )?;

    campaign.commitments = *commitments;
    campaign.kind = *kind;
    campaign.currencies = *currencies;
    campaign.amounts = *amounts;
    campaign.window = args.window;
    campaign.status = campaign_status::QUOTED;
    emit(&QuoteSubmitted {
        discriminator: QuoteSubmitted::DISCRIMINATOR,
        campaign: *campaign_account.address(),
        quote_version: kind.quote_version,
        spec_hash: commitments.spec_hash,
        quote_hash: commitments.quote_hash,
        currency: currencies.currency,
        currency_exponent: currencies.currency_exponent,
        landed_total_minor: amounts.landed_total_minor,
        charge_currency: currencies.charge_currency,
        charge_currency_exponent: currencies.charge_currency_exponent,
        quoted_charge_amount_minor: amounts.quoted_charge_amount_minor,
        settlement_units_per_charge_unit_micros: amounts.settlement_units_per_charge_unit_micros,
        settlement_amount: amounts.settlement_amount,
        quote_expires_at: args.window.expires_at,
    });
    Ok(())
}
