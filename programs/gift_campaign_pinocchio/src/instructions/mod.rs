//! One module per Anchor instruction. Account order matches the Anchor
//! `#[derive(Accounts)]` structs (and therefore the IDL); account checks run
//! first, then the handler's `require!`s in the Anchor order.

pub mod approve_gift;
pub mod approve_quote;
pub mod approve_quote_with_mandate;
pub mod authorize_mandate;
pub mod cancel;
pub mod confirm_delivery;
pub mod create_campaign;
pub mod initialize;
pub mod record_payment_attempt;
pub mod record_payment_attempt_with_mandate;
pub mod record_payment_auth;
pub mod record_purchase;
pub mod revoke_mandate;
pub mod settle_fulfillment;
pub mod submit_quote;
pub mod submit_research;

/// Destructures the leading accounts, failing like Anchor's
/// `AccountNotEnoughKeys` when too few are supplied.
macro_rules! accounts {
    ($accounts:expr, [$($name:ident),+ $(,)?]) => {
        let [$($name,)+ ..] = $accounts else {
            return Err(crate::error::Error::NOT_ENOUGH_ACCOUNT_KEYS);
        };
    };
}
pub(crate) use accounts;
