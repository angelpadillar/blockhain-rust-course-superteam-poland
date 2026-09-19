use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub research_oracle: Pubkey,
    pub delivery_oracle: Pubkey,
    pub allowed_mint: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub sender: Pubkey,
    // Layout v2: local staged migration only; existing deployed accounts require
    // an explicit migration/reallocation before this binary could be deployed.
    pub mandate: Pubkey,
    pub nonce: u64,
    pub budget: u64,
    pub spent: u64,
    pub research_hash: [u8; 32],
    pub gift_hash: [u8; 32],
    pub pod_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub merchant_hash: [u8; 32],
    pub payment_attempt_hash: [u8; 32],
    pub payment_auth_hash: [u8; 32],
    pub purchase_hash: [u8; 32],
    pub order_id_hash: [u8; 32],
    pub fulfillment_hash: [u8; 32],
    pub quote_version: u32,
    pub job_kind: u8,
    pub adapter: u8,
    pub currency: [u8; 3],
    pub currency_exponent: u8,
    pub charge_currency: [u8; 3],
    pub charge_currency_exponent: u8,
    pub item_subtotal_minor: u64,
    pub small_order_fee_minor: u64,
    pub service_fee_minor: u64,
    pub delivery_fee_minor: u64,
    pub tip_minor: u64,
    pub other_fees_minor: u64,
    pub landed_total_minor: u64,
    pub max_total_minor: u64,
    pub settlement_amount: u64,
    pub quoted_charge_amount_minor: u64,
    pub settlement_units_per_charge_unit_micros: u64,
    pub authenticated_amount_minor: u64,
    pub charged_amount_minor: u64,
    pub quote_captured_at: i64,
    pub quote_expires_at: i64,
    pub payment_attempted_at: i64,
    pub payment_authenticated_at: i64,
    pub purchased_at: i64,
    pub created_at: i64,
    pub expires_at: i64,
    pub status: CampaignStatus,
    pub vault_bump: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Mandate {
    pub campaign: Pubkey,
    pub sender: Pubkey,
    pub executor: Pubkey,
    pub merchant_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub recipient_hash: [u8; 32],
    pub charge_currency: [u8; 3],
    pub charge_currency_exponent: u8,
    pub max_charge_amount_minor: u64,
    pub max_escrow_debit: u64,
    pub expires_at: i64,
    pub status: MandateStatus,
    pub approved_terms_hash: [u8; 32],
    pub consumed_at: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, InitSpace, PartialEq)]
pub enum MandateStatus {
    Active,
    Revoked,
    Consumed,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Eq, InitSpace, PartialEq)]
pub enum CampaignStatus {
    Funded,
    Researched,
    Quoted,
    Approved,
    PaymentAttempted,
    PaymentAuthenticated,
    Purchased,
    Delivered,
    Settled,
    Cancelled,
}

impl CampaignStatus {
    pub fn can_cancel(self) -> bool {
        matches!(
            self,
            CampaignStatus::Funded
                | CampaignStatus::Researched
                | CampaignStatus::Quoted
                | CampaignStatus::Approved
                | CampaignStatus::PaymentAttempted
                | CampaignStatus::PaymentAuthenticated
        )
    }

    pub fn sender_can_cancel(self) -> bool {
        matches!(
            self,
            CampaignStatus::Funded
                | CampaignStatus::Researched
                | CampaignStatus::Quoted
                | CampaignStatus::Approved
        )
    }
}
