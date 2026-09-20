//! One-use sender preauthorization, not a new sender signature on every quote.
//! Hashes are opaque commitments: the oracle/executor must verify the actual
//! merchant, item/variant/quantity and recipient off-chain. No address is stored.
use anchor_lang::prelude::*;

use crate::{
    errors::GiftCampaignError,
    state::{Campaign, Config, Mandate, MandateStatus},
};

/// Exact immutable quote + mandate commitment. Integers are little-endian;
/// fixed arrays/pubkeys are raw bytes. This order is the v1 wire contract.
/// The spec and recipient commitments are included together so an approval
/// cannot be replayed with another recipient, campaign, mandate or executor.
pub fn quote_terms_hash(
    campaign_key: Pubkey,
    mandate_key: Pubkey,
    campaign: &Campaign,
    mandate: &Mandate,
    config: &Config,
) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(768);
    bytes.extend_from_slice(b"gift-campaign:mandate-quote:v1");
    for key in [
        crate::ID,
        campaign_key,
        mandate_key,
        config.allowed_mint,
        mandate.campaign,
        mandate.sender,
        mandate.executor,
    ] {
        bytes.extend_from_slice(key.as_ref());
    }
    bytes.extend_from_slice(&config.fee_bps.to_le_bytes());
    bytes.extend_from_slice(&mandate.merchant_hash);
    bytes.extend_from_slice(&mandate.spec_hash);
    bytes.extend_from_slice(&mandate.recipient_hash);
    bytes.extend_from_slice(&mandate.charge_currency);
    bytes.push(mandate.charge_currency_exponent);
    bytes.extend_from_slice(&mandate.max_charge_amount_minor.to_le_bytes());
    bytes.extend_from_slice(&mandate.max_escrow_debit.to_le_bytes());
    bytes.extend_from_slice(&mandate.expires_at.to_le_bytes());
    bytes.extend_from_slice(&campaign.quote_version.to_le_bytes());
    bytes.extend_from_slice(&[campaign.job_kind, campaign.adapter]);
    bytes.extend_from_slice(&campaign.spec_hash);
    bytes.extend_from_slice(&campaign.quote_hash);
    bytes.extend_from_slice(&campaign.merchant_hash);
    bytes.extend_from_slice(&campaign.currency);
    bytes.push(campaign.currency_exponent);
    bytes.extend_from_slice(&campaign.charge_currency);
    bytes.push(campaign.charge_currency_exponent);
    for value in [
        campaign.item_subtotal_minor,
        campaign.small_order_fee_minor,
        campaign.service_fee_minor,
        campaign.delivery_fee_minor,
        campaign.tip_minor,
        campaign.other_fees_minor,
        campaign.landed_total_minor,
        campaign.max_total_minor,
        campaign.settlement_amount,
        campaign.quoted_charge_amount_minor,
        campaign.settlement_units_per_charge_unit_micros,
    ] {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&campaign.quote_captured_at.to_le_bytes());
    bytes.extend_from_slice(&campaign.quote_expires_at.to_le_bytes());
    bytes.extend_from_slice(&campaign.expires_at.to_le_bytes());
    solana_sha256_hasher::hash(&bytes).to_bytes()
}

pub fn validate_mandate_quote(
    campaign_key: Pubkey,
    mandate_key: Pubkey,
    campaign: &Campaign,
    mandate: &Mandate,
    config: &Config,
    executor: Pubkey,
    now: i64,
) -> Result<()> {
    require_keys_eq!(
        campaign.mandate,
        mandate_key,
        GiftCampaignError::MandateMismatch
    );
    require_keys_eq!(
        mandate.campaign,
        campaign_key,
        GiftCampaignError::MandateMismatch
    );
    require_keys_eq!(
        mandate.sender,
        campaign.sender,
        GiftCampaignError::MandateMismatch
    );
    require_keys_eq!(
        executor,
        mandate.executor,
        GiftCampaignError::UnauthorizedExecutor
    );
    require!(
        mandate.status == MandateStatus::Active,
        GiftCampaignError::InactiveMandate
    );
    require!(
        now < mandate.expires_at && now < campaign.quote_expires_at && now < campaign.expires_at,
        GiftCampaignError::MandateExpired
    );
    require!(
        campaign.quote_version > 0 && campaign.quote_hash != [0; 32],
        GiftCampaignError::ZeroHash
    );
    require!(
        campaign.merchant_hash == mandate.merchant_hash
            && campaign.spec_hash == mandate.spec_hash
            && campaign.charge_currency == mandate.charge_currency
            && campaign.charge_currency_exponent == mandate.charge_currency_exponent,
        GiftCampaignError::MandateMismatch
    );
    let fee = campaign
        .settlement_amount
        .checked_mul(u64::from(config.fee_bps))
        .ok_or(GiftCampaignError::ArithmeticOverflow)?
        / 10_000;
    let debit = campaign
        .settlement_amount
        .checked_add(fee)
        .ok_or(GiftCampaignError::ArithmeticOverflow)?;
    // FX metadata remains oracle-supplied; these independently enforced caps
    // bound the actual card charge and token debit without trusting that rate.
    require!(
        campaign.quoted_charge_amount_minor > 0
            && campaign.quoted_charge_amount_minor <= mandate.max_charge_amount_minor
            && debit > 0
            && debit <= mandate.max_escrow_debit
            && debit <= campaign.budget,
        GiftCampaignError::MandateLimitExceeded
    );
    Ok(())
}
