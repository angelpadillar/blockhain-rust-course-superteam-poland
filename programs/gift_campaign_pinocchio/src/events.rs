//! Anchor `#[event]` payloads: 8-byte event discriminator + Borsh fields, laid
//! out as alignment-1 structs so `util::emit` can log them without encoding.

use pinocchio::Address;

macro_rules! event {
    ($name:ident, $discriminator:expr, { $($field:ident: $ty:ty),* $(,)? }) => {
        #[repr(C)]
        pub struct $name {
            pub discriminator: [u8; 8],
            $(pub $field: $ty,)*
        }

        impl $name {
            pub const DISCRIMINATOR: [u8; 8] = $discriminator;
        }
    };
}

event!(MandateAuthorized, [57, 142, 170, 209, 184, 103, 120, 88], {
    campaign: Address,
    mandate: Address,
    sender: Address,
    executor: Address,
    expires_at: [u8; 8],
});

event!(MandateRevoked, [228, 111, 181, 60, 204, 58, 131, 28], {
    campaign: Address,
    mandate: Address,
});

event!(MandateQuoteApproved, [40, 194, 158, 177, 17, 51, 18, 37], {
    campaign: Address,
    mandate: Address,
    quote_version: [u8; 4],
    terms_hash: [u8; 32],
});

event!(MandateConsumed, [204, 129, 243, 227, 0, 120, 168, 33], {
    campaign: Address,
    mandate: Address,
    terms_hash: [u8; 32],
    payment_attempt_hash: [u8; 32],
    consumed_at: [u8; 8],
});

event!(CampaignCreated, [9, 98, 69, 61, 53, 131, 64, 152], {
    campaign: Address,
    sender: Address,
    nonce: [u8; 8],
    budget: [u8; 8],
    expires_at: [u8; 8],
});

event!(ResearchSubmitted, [112, 204, 158, 10, 40, 73, 27, 178], {
    campaign: Address,
    sender: Address,
    nonce: [u8; 8],
    research_hash: [u8; 32],
});

event!(GiftApproved, [71, 65, 88, 204, 13, 37, 115, 216], {
    campaign: Address,
    sender: Address,
    nonce: [u8; 8],
    gift_hash: [u8; 32],
});

event!(QuoteSubmitted, [207, 98, 251, 106, 249, 124, 126, 40], {
    campaign: Address,
    quote_version: [u8; 4],
    spec_hash: [u8; 32],
    quote_hash: [u8; 32],
    currency: [u8; 3],
    currency_exponent: u8,
    landed_total_minor: [u8; 8],
    charge_currency: [u8; 3],
    charge_currency_exponent: u8,
    quoted_charge_amount_minor: [u8; 8],
    settlement_units_per_charge_unit_micros: [u8; 8],
    settlement_amount: [u8; 8],
    quote_expires_at: [u8; 8],
});

event!(QuoteApproved, [195, 187, 60, 1, 21, 241, 38, 27], {
    campaign: Address,
    sender: Address,
    quote_version: [u8; 4],
    quote_hash: [u8; 32],
    landed_total_minor: [u8; 8],
});

event!(PaymentAttempted, [28, 98, 91, 136, 170, 151, 144, 122], {
    campaign: Address,
    quote_version: [u8; 4],
    payment_attempt_hash: [u8; 32],
    attempted_at: [u8; 8],
});

event!(PaymentAuthenticated, [65, 209, 21, 220, 159, 11, 188, 62], {
    campaign: Address,
    payment_auth_hash: [u8; 32],
    currency: [u8; 3],
    authenticated_amount_minor: [u8; 8],
    authenticated_at: [u8; 8],
});

event!(PurchaseConfirmed, [118, 225, 191, 5, 206, 38, 175, 130], {
    campaign: Address,
    purchase_hash: [u8; 32],
    order_id_hash: [u8; 32],
    currency: [u8; 3],
    charged_amount_minor: [u8; 8],
    purchased_at: [u8; 8],
});

event!(FulfillmentSettled, [162, 94, 27, 10, 123, 8, 243, 182], {
    campaign: Address,
    pod_hash: [u8; 32],
    fulfillment_hash: [u8; 32],
    operator_payment: [u8; 8],
    fee: [u8; 8],
    refund: [u8; 8],
});

event!(DeliveryConfirmed, [225, 181, 249, 139, 185, 125, 219, 154], {
    campaign: Address,
    sender: Address,
    nonce: [u8; 8],
    pod_hash: [u8; 32],
    fee: [u8; 8],
    refund: [u8; 8],
});

event!(CampaignCancelled, [121, 171, 21, 55, 56, 234, 121, 44], {
    campaign: Address,
    sender: Address,
    nonce: [u8; 8],
    refund: [u8; 8],
});
