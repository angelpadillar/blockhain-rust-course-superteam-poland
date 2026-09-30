//! One-use sender preauthorization (see the Anchor `mandate` module). Hashes
//! are opaque commitments verified off-chain; no address is stored.

use {
    crate::{
        error::{require, GiftCampaignError, Result},
        state::{mandate_status, Campaign, Config, Mandate},
        util::{bytes_of, escrow_debit, i64_le, u64_le},
        ID,
    },
    pinocchio::Address,
};

const DOMAIN: &[u8] = b"gift-campaign:mandate-quote:v1";

/// SHA-256 of the v1 wire contract, identical to the Anchor
/// `quote_terms_hash`. Each slice below is a contiguous run of account data
/// that the Anchor version appends field by field.
pub fn quote_terms_hash(
    campaign_key: &Address,
    mandate_key: &Address,
    campaign: &Campaign,
    mandate: &Mandate,
    config: &Config,
) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        DOMAIN,
        ID.as_ref(),
        campaign_key.as_ref(),
        mandate_key.as_ref(),
        config.allowed_mint.as_ref(),
        bytes_of(&mandate.parties), // campaign, sender, executor
        &config.fee_bps,
        bytes_of(&mandate.terms),        // merchant_hash .. expires_at
        campaign.kind_bytes(),           // quote_version, job_kind, adapter
        bytes_of(&campaign.commitments), // spec_hash, quote_hash, merchant_hash
        bytes_of(&campaign.currencies),  // currency .. charge_currency_exponent
        bytes_of(&campaign.amounts), // item_subtotal_minor .. settlement_units_per_charge_unit_micros
        bytes_of(&campaign.window),  // quote_captured_at, quote_expires_at
        &campaign.expires_at,
    ])
    .to_bytes()
}

pub fn validate_mandate_quote(
    campaign_key: &Address,
    mandate_key: &Address,
    campaign: &Campaign,
    mandate: &Mandate,
    config: &Config,
    executor: &Address,
    now: i64,
) -> Result<()> {
    require(
        campaign.mandate == *mandate_key,
        GiftCampaignError::MandateMismatch,
    )?;
    require(
        mandate.parties.campaign == *campaign_key,
        GiftCampaignError::MandateMismatch,
    )?;
    require(
        mandate.parties.sender == campaign.sender,
        GiftCampaignError::MandateMismatch,
    )?;
    require(
        *executor == mandate.parties.executor,
        GiftCampaignError::UnauthorizedExecutor,
    )?;
    require(
        mandate.status == mandate_status::ACTIVE,
        GiftCampaignError::InactiveMandate,
    )?;
    require(
        now < i64_le(&mandate.terms.expires_at)
            && now < i64_le(&campaign.window.expires_at)
            && now < i64_le(&campaign.expires_at),
        GiftCampaignError::MandateExpired,
    )?;
    require(
        u32::from_le_bytes(campaign.kind.quote_version) > 0
            && campaign.commitments.quote_hash != [0; 32],
        GiftCampaignError::ZeroHash,
    )?;
    require(
        campaign.commitments.merchant_hash == mandate.terms.merchant_hash
            && campaign.commitments.spec_hash == mandate.terms.spec_hash
            && campaign.currencies.charge_currency == mandate.terms.charge_currency
            && campaign.currencies.charge_currency_exponent
                == mandate.terms.charge_currency_exponent,
        GiftCampaignError::MandateMismatch,
    )?;
    let debit = escrow_debit(u64_le(&campaign.amounts.settlement_amount), &config.fee_bps)?;
    let quoted_charge = u64_le(&campaign.amounts.quoted_charge_amount_minor);
    // FX metadata remains oracle-supplied; these independently enforced caps
    // bound the actual card charge and token debit without trusting that rate.
    require(
        quoted_charge > 0
            && quoted_charge <= u64_le(&mandate.terms.max_charge_amount_minor)
            && debit > 0
            && debit <= u64_le(&mandate.terms.max_escrow_debit)
            && debit <= u64_le(&campaign.budget),
        GiftCampaignError::MandateLimitExceeded,
    )
}
