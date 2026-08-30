use anchor_lang::prelude::*;

#[event]
pub struct CampaignCreated {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub nonce: u64,
    pub budget: u64,
    pub expires_at: i64,
}

#[event]
pub struct ResearchSubmitted {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub nonce: u64,
    pub research_hash: [u8; 32],
}

#[event]
pub struct GiftApproved {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub nonce: u64,
    pub gift_hash: [u8; 32],
}

#[event]
pub struct QuoteSubmitted {
    pub campaign: Pubkey,
    pub quote_version: u32,
    pub spec_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub currency: [u8; 3],
    pub currency_exponent: u8,
    pub landed_total_minor: u64,
    pub charge_currency: [u8; 3],
    pub charge_currency_exponent: u8,
    pub quoted_charge_amount_minor: u64,
    pub settlement_units_per_charge_unit_micros: u64,
    pub settlement_amount: u64,
    pub quote_expires_at: i64,
}

#[event]
pub struct QuoteApproved {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub quote_version: u32,
    pub quote_hash: [u8; 32],
    pub landed_total_minor: u64,
}

#[event]
pub struct PaymentAttempted {
    pub campaign: Pubkey,
    pub quote_version: u32,
    pub payment_attempt_hash: [u8; 32],
    pub attempted_at: i64,
}

#[event]
pub struct PaymentAuthenticated {
    pub campaign: Pubkey,
    pub payment_auth_hash: [u8; 32],
    pub currency: [u8; 3],
    pub authenticated_amount_minor: u64,
    pub authenticated_at: i64,
}

#[event]
pub struct PurchaseConfirmed {
    pub campaign: Pubkey,
    pub purchase_hash: [u8; 32],
    pub order_id_hash: [u8; 32],
    pub currency: [u8; 3],
    pub charged_amount_minor: u64,
    pub purchased_at: i64,
}

#[event]
pub struct FulfillmentSettled {
    pub campaign: Pubkey,
    pub pod_hash: [u8; 32],
    pub fulfillment_hash: [u8; 32],
    pub operator_payment: u64,
    pub fee: u64,
    pub refund: u64,
}

#[event]
pub struct DeliveryConfirmed {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub nonce: u64,
    pub pod_hash: [u8; 32],
    pub fee: u64,
    pub refund: u64,
}

#[event]
pub struct CampaignCancelled {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub nonce: u64,
    pub refund: u64,
}
