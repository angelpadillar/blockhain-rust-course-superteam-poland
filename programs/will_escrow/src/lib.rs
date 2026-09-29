//! Applied Will escrow. The customer's funds sit in a per-job vault; each
//! purchase is paid from it at checkout, and the fee is released only after
//! proof of delivery and a dispute window.
#![cfg_attr(not(test), no_std)]

pub mod error;
pub mod instructions;
pub mod payout;
pub mod state;
#[cfg(test)]
mod test_utils;
pub mod util;

pub use pinocchio::Address;
use {
    error::{Error, Result},
    pinocchio::AccountView,
};

pub const ID: Address = Address::from_str_const("Gb6xwa6T348n7d67Ri5c42ENeQqbwLuf4d6W9an9rbZb");

/// This program's ProgramData account under the upgradeable loader, which
/// records the upgrade authority allowed to initialize the config.
pub const PROGRAM_DATA: Address =
    Address::from_str_const("CcHoibXJsxpAt7eYd3WDtMNR4dHpAZ1P8aDA4egXxGo2");

/// Upper bound on the configurable protocol fee (10%).
pub const MAX_FEE_BPS: u16 = 1_000;

/// Fees are in basis points of the amount spent.
pub const BASIS_POINTS: u64 = 10_000;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use {
        core::mem::MaybeUninit,
        pinocchio::{
            entrypoint::lazy::{InstructionContext, MaybeAccount},
            AccountView,
        },
    };

    /// The largest instruction takes 9 accounts; extra accounts are ignored.
    const MAX_ACCOUNTS: usize = 9;

    /// Parses accounts with a loop over the lazy parser (far smaller than
    /// Pinocchio's unrolled eager parser) and returns the error's `u64`
    /// encoding directly.
    ///
    /// # Safety
    ///
    /// Called by the runtime with its serialized input buffer.
    #[no_mangle]
    pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
        // SAFETY: `input` is the loader's serialized buffer.
        let mut context = unsafe { InstructionContext::new_unchecked(input) };
        let mut accounts = [const { MaybeUninit::<AccountView>::uninit() }; MAX_ACCOUNTS];
        let mut count = 0;
        for _ in 0..context.remaining() {
            // SAFETY: exactly `remaining()` accounts precede the instruction
            // data; every one is consumed so the cursor ends at the data.
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

/// Handlers indexed by the 1-byte instruction discriminator. The table holds
/// only function pointers: platform-tools v1.52 zeroes the upper half of plain
/// 64-bit words that share a static with relocated pointers.
static HANDLERS: [Handler; 13] = [
    instructions::initialize_config::process,
    instructions::update_config::process,
    instructions::create_job::process,
    not_yet,
    not_yet,
    not_yet,
    not_yet,
    not_yet,
    not_yet,
    not_yet,
    not_yet,
    instructions::cancel::process,
    instructions::refund_expired::process,
];

/// Placeholder for discriminators whose instruction is not implemented yet.
fn not_yet(_accounts: &mut [AccountView], _args: &[u8]) -> Result {
    Err(Error::INVALID_INSTRUCTION_DATA)
}

pub fn process_instruction(accounts: &mut [AccountView], data: &[u8]) -> Result {
    let Some((&tag, args)) = data.split_first() else {
        return Err(Error::INVALID_INSTRUCTION_DATA);
    };
    match HANDLERS.get(usize::from(tag)) {
        Some(handler) => handler(accounts, args),
        None => Err(Error::INVALID_INSTRUCTION_DATA),
    }
}

#[cfg(test)]
mod tests {
    use crate::{error::Error, process_instruction};

    #[test]
    fn empty_instruction_data_is_rejected() {
        assert_eq!(
            process_instruction(&mut [], &[]),
            Err(Error::INVALID_INSTRUCTION_DATA)
        );
    }

    #[test]
    fn unknown_discriminators_are_rejected() {
        for tag in [13u8, 200, 255] {
            assert_eq!(
                process_instruction(&mut [], &[tag]),
                Err(Error::INVALID_INSTRUCTION_DATA),
                "tag {tag}"
            );
        }
    }
}
