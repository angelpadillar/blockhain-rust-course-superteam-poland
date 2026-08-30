pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use instructions::*;

declare_id!("F1dNhkpGn5eVL9xWcsnRUf3jevAJdDCU7UN5u7YAEhYb");

#[program]
pub mod gift_campaign {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, fee_bps)
    }

    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        nonce: u64,
        budget: u64,
        expires_at: i64,
    ) -> Result<()> {
        instructions::create_campaign::handle_create_campaign(ctx, nonce, budget, expires_at)
    }

    pub fn submit_research(ctx: Context<SubmitResearch>, research_hash: [u8; 32]) -> Result<()> {
        instructions::submit_research::handle_submit_research(ctx, research_hash)
    }

    pub fn approve_gift(ctx: Context<ApproveGift>, gift_hash: [u8; 32]) -> Result<()> {
        instructions::approve_gift::handle_approve_gift(ctx, gift_hash)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn submit_quote(
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
        instructions::submit_quote::handle_submit_quote(
            ctx,
            quote_version,
            job_kind,
            adapter,
            spec_hash,
            quote_hash,
            merchant_hash,
            currency,
            currency_exponent,
            charge_currency,
            charge_currency_exponent,
            item_subtotal_minor,
            small_order_fee_minor,
            service_fee_minor,
            delivery_fee_minor,
            tip_minor,
            other_fees_minor,
            landed_total_minor,
            max_total_minor,
            settlement_amount,
            quoted_charge_amount_minor,
            settlement_units_per_charge_unit_micros,
            quote_captured_at,
            quote_expires_at,
        )
    }

    pub fn approve_quote(
        ctx: Context<ApproveQuote>,
        quote_version: u32,
        quote_hash: [u8; 32],
    ) -> Result<()> {
        instructions::approve_quote::handle_approve_quote(ctx, quote_version, quote_hash)
    }

    pub fn record_payment_attempt(
        ctx: Context<RecordPaymentAttempt>,
        quote_version: u32,
        quote_hash: [u8; 32],
        payment_attempt_hash: [u8; 32],
    ) -> Result<()> {
        instructions::record_payment_attempt::handle_record_payment_attempt(
            ctx,
            quote_version,
            quote_hash,
            payment_attempt_hash,
        )
    }

    pub fn record_payment_auth(
        ctx: Context<RecordPaymentAuth>,
        payment_auth_hash: [u8; 32],
        currency: [u8; 3],
        authenticated_amount_minor: u64,
    ) -> Result<()> {
        instructions::record_payment_auth::handle_record_payment_auth(
            ctx,
            payment_auth_hash,
            currency,
            authenticated_amount_minor,
        )
    }

    pub fn record_purchase(
        ctx: Context<RecordPurchase>,
        purchase_hash: [u8; 32],
        order_id_hash: [u8; 32],
        currency: [u8; 3],
        charged_amount_minor: u64,
    ) -> Result<()> {
        instructions::record_purchase::handle_record_purchase(
            ctx,
            purchase_hash,
            order_id_hash,
            currency,
            charged_amount_minor,
        )
    }

    pub fn settle_fulfillment(
        ctx: Context<SettleFulfillment>,
        pod_hash: [u8; 32],
        fulfillment_hash: [u8; 32],
    ) -> Result<()> {
        instructions::settle_fulfillment::handle_settle_fulfillment(ctx, pod_hash, fulfillment_hash)
    }

    pub fn confirm_delivery(ctx: Context<ConfirmDelivery>, pod_hash: [u8; 32]) -> Result<()> {
        instructions::confirm_delivery::handle_confirm_delivery(ctx, pod_hash)
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }
}
