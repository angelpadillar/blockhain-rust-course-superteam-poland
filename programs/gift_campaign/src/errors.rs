use anchor_lang::prelude::*;

#[error_code]
pub enum GiftCampaignError {
    #[msg("The platform fee cannot exceed 10%")]
    FeeTooHigh,
    #[msg("Campaign budget must be greater than zero")]
    InvalidBudget,
    #[msg("Campaign expiry must be in the future")]
    InvalidExpiry,
    #[msg("This instruction is not valid for the campaign's current state")]
    InvalidCampaignState,
    #[msg("A commitment hash cannot be all zeroes")]
    ZeroHash,
    #[msg("Only the configured research oracle may submit research")]
    UnauthorizedResearchOracle,
    #[msg("Only the configured delivery oracle may confirm delivery")]
    UnauthorizedDeliveryOracle,
    #[msg("Only the sender may approve the gift")]
    UnauthorizedSender,
    #[msg("Only the sender, or the delivery oracle after expiry, may cancel")]
    UnauthorizedCancellation,
    #[msg("Delivery confirmation arrived after campaign expiry")]
    CampaignExpired,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Only the configured fulfillment oracle may record fulfillment progress")]
    UnauthorizedFulfillmentOracle,
    #[msg("The quote fee components do not equal the landed total")]
    QuoteTotalMismatch,
    #[msg("The quote exceeds its approved maximum")]
    QuoteExceedsMaximum,
    #[msg("The quote or campaign has expired")]
    QuoteExpired,
    #[msg("The quote version or commitment does not match")]
    QuoteMismatch,
    #[msg("The payment amount or currency does not match the approved quote")]
    PaymentMismatch,
    #[msg("The quote currency is unsupported")]
    UnsupportedCurrency,
    #[msg("The escrow budget cannot cover the exact settlement and protocol fee")]
    InsufficientEscrowBudget,
}
