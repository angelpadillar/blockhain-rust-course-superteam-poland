//! Pinocchio port of the Anchor `gift_campaign` program.
//!
//! Wire-compatible with the Anchor build: same program id, instruction and
//! account discriminators, account layouts, argument encoding, event payloads
//! and custom error codes, so the generated IDL, the TypeScript types and the
//! Rust clients keep working unchanged. What it drops is Anchor's runtime
//! overhead: log strings, Borsh (de)serialisation, heap allocation and the
//! per-instruction `Instruction: ...` log line.
#![cfg_attr(not(test), no_std)]

pub mod error;
pub mod events;
pub mod instructions;
pub mod mandate;
pub mod state;
pub mod util;
mod vault;

use {
    error::{Error, Result},
    pinocchio::{AccountView, Address},
};

pub const ID: Address = Address::from_str_const("F1dNhkpGn5eVL9xWcsnRUf3jevAJdDCU7UN5u7YAEhYb");

pub const CONFIG_SEED: &[u8] = b"config";
pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MANDATE_SEED: &[u8] = b"mandate";
pub const BASIS_POINTS_DENOMINATOR: u64 = 10_000;
pub const MAX_FEE_BPS: u16 = 1_000;

/// Anchor instruction discriminators: `sha256("global:<name>")[..8]`.
pub mod discriminator {
    const fn le(bytes: [u8; 8]) -> u64 {
        u64::from_le_bytes(bytes)
    }
    pub const INITIALIZE: u64 = le([175, 175, 109, 31, 13, 152, 155, 237]);
    pub const CREATE_CAMPAIGN: u64 = le([111, 131, 187, 98, 160, 193, 114, 244]);
    pub const SUBMIT_RESEARCH: u64 = le([42, 32, 166, 209, 223, 119, 23, 164]);
    pub const APPROVE_GIFT: u64 = le([188, 69, 46, 104, 224, 48, 6, 112]);
    pub const AUTHORIZE_MANDATE: u64 = le([195, 156, 128, 144, 26, 21, 89, 88]);
    pub const REVOKE_MANDATE: u64 = le([252, 97, 140, 119, 67, 43, 177, 108]);
    pub const APPROVE_QUOTE_WITH_MANDATE: u64 = le([171, 205, 71, 173, 250, 188, 250, 98]);
    pub const RECORD_PAYMENT_ATTEMPT_WITH_MANDATE: u64 = le([9, 35, 239, 131, 42, 103, 203, 151]);
    pub const SUBMIT_QUOTE: u64 = le([230, 121, 122, 202, 228, 6, 91, 181]);
    pub const APPROVE_QUOTE: u64 = le([168, 203, 252, 157, 236, 35, 139, 58]);
    pub const RECORD_PAYMENT_ATTEMPT: u64 = le([155, 94, 175, 153, 52, 242, 28, 129]);
    pub const RECORD_PAYMENT_AUTH: u64 = le([151, 209, 244, 83, 51, 227, 41, 205]);
    pub const RECORD_PURCHASE: u64 = le([107, 25, 137, 125, 231, 17, 11, 60]);
    pub const SETTLE_FULFILLMENT: u64 = le([227, 255, 167, 148, 117, 64, 149, 119]);
    pub const CONFIRM_DELIVERY: u64 = le([11, 109, 227, 53, 179, 190, 88, 155]);
    pub const CANCEL: u64 = le([232, 219, 223, 41, 219, 236, 220, 190]);
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use {
        core::mem::MaybeUninit,
        pinocchio::{
            entrypoint::lazy::{InstructionContext, MaybeAccount},
            AccountView,
        },
    };

    /// The largest instruction takes eight accounts; extra accounts are
    /// ignored, like Anchor's `remaining_accounts`.
    const MAX_ACCOUNTS: usize = 8;

    /// Returns the error's `u64` encoding directly instead of converting a
    /// `ProgramError` on the way out.
    ///
    /// # Safety
    ///
    /// Called by the runtime with its serialized input buffer.
    #[no_mangle]
    pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
        // A loop over the lazy parser is far smaller than Pinocchio's unrolled
        // eager `deserialize`, with the same result: the first `MAX_ACCOUNTS`
        // views, duplicates resolved to their first occurrence.
        // SAFETY: `input` is the loader's serialized buffer.
        let mut context = unsafe { InstructionContext::new_unchecked(input) };
        let mut accounts = [const { MaybeUninit::<AccountView>::uninit() }; MAX_ACCOUNTS];
        let mut count = 0;
        for _ in 0..context.remaining() {
            // SAFETY: exactly `remaining()` accounts precede the instruction data;
            // every one is consumed so the cursor ends at the data.
            let next = unsafe { context.next_account_unchecked() };
            if count < MAX_ACCOUNTS {
                let view = match next {
                    MaybeAccount::Account(view) => view,
                    // SAFETY: a duplicate marker names an earlier position, and
                    // positions below `MAX_ACCOUNTS` are stored in order.
                    MaybeAccount::Duplicated(index) => unsafe {
                        accounts.get_unchecked(index as usize).assume_init_read()
                    },
                };
                // SAFETY: `count < MAX_ACCOUNTS`.
                unsafe { accounts.get_unchecked_mut(count).write(view) };
                count += 1;
            }
        }
        // SAFETY: all accounts were consumed above.
        let data = unsafe { context.instruction_data_unchecked() };
        // SAFETY: the first `count` views were initialized above.
        let accounts = unsafe {
            core::slice::from_raw_parts_mut(accounts.as_mut_ptr() as *mut AccountView, count)
        };
        match crate::process_instruction(accounts, data) {
            Ok(()) => pinocchio::SUCCESS,
            Err(error) => error.code(),
        }
    }

    pinocchio::no_allocator!();

    /// Abort without formatting: panic locations would only add strings.
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    #[panic_handler]
    fn panic(_info: &core::panic::PanicInfo<'_>) -> ! {
        // SAFETY: `abort` never returns.
        unsafe { pinocchio::syscalls::abort() }
    }
}

type Handler = fn(&mut [AccountView], &[u8]) -> Result;

/// Anchor discriminators and their handlers, index-aligned. They are kept in
/// separate tables: platform-tools v1.52 zeroes the upper half of plain 64-bit
/// words that share a static with relocated function pointers.
static DISCRIMINATORS: [u64; 16] = {
    use discriminator::*;
    [
        INITIALIZE,
        CREATE_CAMPAIGN,
        SUBMIT_RESEARCH,
        APPROVE_GIFT,
        AUTHORIZE_MANDATE,
        REVOKE_MANDATE,
        APPROVE_QUOTE_WITH_MANDATE,
        RECORD_PAYMENT_ATTEMPT_WITH_MANDATE,
        SUBMIT_QUOTE,
        APPROVE_QUOTE,
        RECORD_PAYMENT_ATTEMPT,
        RECORD_PAYMENT_AUTH,
        RECORD_PURCHASE,
        SETTLE_FULFILLMENT,
        CONFIRM_DELIVERY,
        CANCEL,
    ]
};

static HANDLERS: [Handler; 16] = {
    use instructions::*;
    [
        initialize::process,
        create_campaign::process,
        submit_research::process,
        approve_gift::process,
        authorize_mandate::process,
        revoke_mandate::process,
        approve_quote_with_mandate::process,
        record_payment_attempt_with_mandate::process,
        submit_quote::process,
        approve_quote::process,
        record_payment_attempt::process,
        record_payment_auth::process,
        record_purchase::process,
        settle_fulfillment::process,
        confirm_delivery::process,
        cancel::process,
    ]
};

pub fn process_instruction(accounts: &mut [AccountView], data: &[u8]) -> Result {
    let Some((tag, args)) = data.split_first_chunk::<8>() else {
        return Err(Error::INVALID_INSTRUCTION_DATA);
    };
    let tag = u64::from_le_bytes(*tag);
    // Every discriminator is compared in full.
    match DISCRIMINATORS
        .iter()
        .zip(HANDLERS.iter())
        .find(|(discriminator, _)| **discriminator == tag)
    {
        Some((_, handler)) => handler(accounts, args),
        None => Err(Error::INVALID_INSTRUCTION_DATA),
    }
}
