use anchor_lang::prelude::*;

use crate::{
    constants::{BASIS_POINTS_DENOMINATOR, CONFIG_SEED},
    errors::GiftCampaignError,
    events::QuoteSubmitted,
    state::{Campaign, CampaignStatus, Config},
};

#[derive(Accounts)]
pub struct SubmitQuote<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub campaign: Box<Account<'info, Campaign>>,
    pub research_oracle: Signer<'info>,
}

#[allow(clippy::too_many_arguments)]
pub fn handle_submit_quote(
    ctx: Context<SubmitQuote>,
    quote_version: u32,
    job_kind: u8,
    adapter: u8,
    spec_hash: [u8; 32],
    quote_hash: [u8; 32],
    merchant_hash: [u8; 32],
    currency: [u8; 3],
    currency_exponent: u8,
    charge_currency: [u8; 3],
    charge_currency_exponent: u8,
    item_subtotal_minor: u64,
    small_order_fee_minor: u64,
    service_fee_minor: u64,
    delivery_fee_minor: u64,
    tip_minor: u64,
    other_fees_minor: u64,
    landed_total_minor: u64,
    max_total_minor: u64,
    settlement_amount: u64,
    quoted_charge_amount_minor: u64,
    settlement_units_per_charge_unit_micros: u64,
    quote_captured_at: i64,
    quote_expires_at: i64,
) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.research_oracle.key(),
        ctx.accounts.config.research_oracle,
        GiftCampaignError::UnauthorizedResearchOracle
    );
    require!(
        matches!(
            ctx.accounts.campaign.status,
            CampaignStatus::Funded | CampaignStatus::Researched
        ),
        GiftCampaignError::InvalidCampaignState
    );
    require!(
        quote_version > 0 && job_kind <= 3 && adapter <= 3,
        GiftCampaignError::QuoteMismatch
    );
    for hash in [spec_hash, quote_hash, merchant_hash] {
        require!(hash != [0; 32], GiftCampaignError::ZeroHash);
    }
    require!(
        currency.iter().all(u8::is_ascii_uppercase)
            && charge_currency.iter().all(u8::is_ascii_uppercase)
            && currency_exponent <= 4
            && charge_currency_exponent <= 4,
        GiftCampaignError::UnsupportedCurrency
    );

    let calculated_total = item_subtotal_minor
        .checked_add(small_order_fee_minor)
        .and_then(|value| value.checked_add(service_fee_minor))
        .and_then(|value| value.checked_add(delivery_fee_minor))
        .and_then(|value| value.checked_add(tip_minor))
        .and_then(|value| value.checked_add(other_fees_minor))
        .ok_or(GiftCampaignError::ArithmeticOverflow)?;
    require!(
        landed_total_minor > 0 && calculated_total == landed_total_minor,
        GiftCampaignError::QuoteTotalMismatch
    );
    require!(
        max_total_minor > 0 && landed_total_minor <= max_total_minor,
        GiftCampaignError::QuoteExceedsMaximum
    );
    require!(
        settlement_amount > 0
            && quoted_charge_amount_minor > 0
            && settlement_units_per_charge_unit_micros > 0,
        GiftCampaignError::InvalidBudget
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        quote_captured_at <= quote_expires_at
            && quote_expires_at > now
            && quote_expires_at <= ctx.accounts.campaign.expires_at,
        GiftCampaignError::QuoteExpired
    );
    let fee = settlement_amount
        .checked_mul(u64::from(ctx.accounts.config.fee_bps))
        .ok_or(GiftCampaignError::ArithmeticOverflow)?
        .checked_div(BASIS_POINTS_DENOMINATOR)
        .ok_or(GiftCampaignError::ArithmeticOverflow)?;
    let required_budget = settlement_amount
        .checked_add(fee)
        .ok_or(GiftCampaignError::ArithmeticOverflow)?;
    require!(
        required_budget <= ctx.accounts.campaign.budget,
        GiftCampaignError::InsufficientEscrowBudget
    );

    let campaign = &mut ctx.accounts.campaign;
    campaign.spec_hash = spec_hash;
    campaign.quote_hash = quote_hash;
    campaign.merchant_hash = merchant_hash;
    campaign.quote_version = quote_version;
    campaign.job_kind = job_kind;
    campaign.adapter = adapter;
    campaign.currency = currency;
    campaign.currency_exponent = currency_exponent;
    campaign.charge_currency = charge_currency;
    campaign.charge_currency_exponent = charge_currency_exponent;
    campaign.item_subtotal_minor = item_subtotal_minor;
    campaign.small_order_fee_minor = small_order_fee_minor;
    campaign.service_fee_minor = service_fee_minor;
    campaign.delivery_fee_minor = delivery_fee_minor;
    campaign.tip_minor = tip_minor;
    campaign.other_fees_minor = other_fees_minor;
    campaign.landed_total_minor = landed_total_minor;
    campaign.max_total_minor = max_total_minor;
    campaign.settlement_amount = settlement_amount;
    campaign.quoted_charge_amount_minor = quoted_charge_amount_minor;
    campaign.settlement_units_per_charge_unit_micros = settlement_units_per_charge_unit_micros;
    campaign.quote_captured_at = quote_captured_at;
    campaign.quote_expires_at = quote_expires_at;
    campaign.status = CampaignStatus::Quoted;

    emit!(QuoteSubmitted {
        campaign: campaign.key(),
        quote_version,
        spec_hash,
        quote_hash,
        currency,
        currency_exponent,
        landed_total_minor,
        charge_currency,
        charge_currency_exponent,
        quoted_charge_amount_minor,
        settlement_units_per_charge_unit_micros,
        settlement_amount,
        quote_expires_at,
    });
    Ok(())
}
