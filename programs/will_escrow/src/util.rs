//! Validation and PDA helpers. Each documents the check it performs.

use {
    crate::{
        error::{Error, Result},
        ID,
    },
    core::slice::from_raw_parts,
    pinocchio::AccountView,
};

const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";

/// The raw bytes of a `#[repr(C)]` view made only of byte arrays.
#[inline(always)]
pub fn bytes_of<T>(value: &T) -> &[u8] {
    // SAFETY: callers only pass alignment-1 structs of byte arrays (no padding).
    unsafe { from_raw_parts(value as *const T as *const u8, size_of::<T>()) }
}

/// `account` is the PDA of `seeds` (which include the bump). Unused trailing
/// entries are empty and do not change the SHA-256 preimage. Only for accounts
/// this program created, whose stored bump is the canonical one.
pub fn check_pda(account: &AccountView, seeds: [&[u8]; 4]) -> Result {
    let derived = solana_sha256_hasher::hashv(&[
        seeds[0],
        seeds[1],
        seeds[2],
        seeds[3],
        ID.as_ref(),
        PDA_MARKER,
    ]);
    if derived.as_bytes() == account.address().as_array() {
        Ok(())
    } else {
        Err(Error::INVALID_SEEDS)
    }
}
