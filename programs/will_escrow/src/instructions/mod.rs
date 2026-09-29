//! One module per instruction. Each defines its 1-byte `DISCRIMINATOR`, an
//! alignment-1 `Args` struct (which is also its Codama IDL description) and
//! `process`.

// Clippy reads the flags inside separate `codama(account(..))` attributes as
// duplicated attributes; each describes a different account.
#![allow(clippy::duplicated_attributes)]

pub mod cancel;
pub mod create_job;
pub mod initialize_config;
pub mod refund_expired;
pub mod update_config;
