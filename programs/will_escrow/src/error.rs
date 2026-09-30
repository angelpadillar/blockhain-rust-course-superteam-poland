use {core::num::NonZeroU64, pinocchio::error::ProgramError};

/// Program errors, returned as `custom program error` codes from 6000. The
/// numbering is part of the client ABI: append new variants, never reorder.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
#[cfg_attr(feature = "idl", derive(codama::CodamaErrors))]
pub enum WillError {
    /// Config is paused: no new jobs or releases.
    Paused = 6000,
    /// The instruction is not valid in the job's current state.
    BadState,
    /// Only the configured operator may do this.
    NotOperator,
    /// Only the job's customer may do this.
    NotCustomer,
    /// Only the config admin may do this.
    NotAdmin,
    /// Only the program's upgrade authority may initialize the config.
    NotUpgradeAuthority,
    /// The amount exceeds the approved cap.
    CapExceeded,
    /// The destination is not an allowlisted funding account.
    FundingNotAllowed,
    /// The dispute window is still open.
    WindowOpen,
    /// The dispute window has closed.
    WindowClosed,
    /// The timeout has not passed yet.
    NotExpired,
    /// The signed terms do not match the job's quote.
    TermsMismatch,
    /// The quote has expired.
    QuoteExpired,
    /// A job kind or adapter code is outside 0..=15.
    KindOutOfRange,
    /// An amount, total or configuration value is invalid.
    BadAmount,
    /// Arithmetic overflowed.
    Overflow,
    /// A payout or rent destination does not belong to the recorded party.
    WrongRecipient,
    /// The customer's sign-off must come in a later slot than the proof.
    SignOffTooEarly,
}

/// A program error in its final `u64` entrypoint encoding. `Result<(), Error>`
/// fits in one register, which keeps the many `?` sites small.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(transparent)]
pub struct Error(NonZeroU64);

pub type Result<T = ()> = core::result::Result<T, Error>;

impl Error {
    const fn builtin(code: u64) -> Self {
        match NonZeroU64::new(code) {
            Some(code) => Self(code),
            None => panic!("error codes are non-zero"),
        }
    }

    pub const INVALID_INSTRUCTION_DATA: Self =
        Self::builtin(pinocchio::error::INVALID_INSTRUCTION_DATA);
    pub const INVALID_ARGUMENT: Self = Self::builtin(pinocchio::error::INVALID_ARGUMENT);
    pub const INVALID_ACCOUNT_DATA: Self = Self::builtin(pinocchio::error::INVALID_ACCOUNT_DATA);
    pub const ACCOUNT_DATA_TOO_SMALL: Self =
        Self::builtin(pinocchio::error::ACCOUNT_DATA_TOO_SMALL);
    pub const INVALID_SEEDS: Self = Self::builtin(pinocchio::error::INVALID_SEEDS);
    pub const INVALID_ACCOUNT_OWNER: Self = Self::builtin(pinocchio::error::INVALID_ACCOUNT_OWNER);
    pub const MISSING_REQUIRED_SIGNATURE: Self =
        Self::builtin(pinocchio::error::MISSING_REQUIRED_SIGNATURES);
    pub const IMMUTABLE: Self = Self::builtin(pinocchio::error::IMMUTABLE);
    pub const INCORRECT_PROGRAM_ID: Self = Self::builtin(pinocchio::error::INCORRECT_PROGRAM_ID);
    pub const UNINITIALIZED_ACCOUNT: Self = Self::builtin(pinocchio::error::UNINITIALIZED_ACCOUNT);
    pub const NOT_ENOUGH_ACCOUNT_KEYS: Self =
        Self::builtin(pinocchio::error::NOT_ENOUGH_ACCOUNT_KEYS);
    pub const ARITHMETIC_OVERFLOW: Self = Self::builtin(pinocchio::error::ARITHMETIC_OVERFLOW);
    pub const UNSUPPORTED_SYSVAR: Self = Self::builtin(pinocchio::error::UNSUPPORTED_SYSVAR);

    /// The value the entrypoint returns to the runtime.
    #[inline(always)]
    pub fn code(self) -> u64 {
        self.0.get()
    }
}

impl From<WillError> for Error {
    #[inline(always)]
    fn from(error: WillError) -> Self {
        // SAFETY: every variant is >= 6000.
        Self(unsafe { NonZeroU64::new_unchecked(error as u64) })
    }
}

/// `require!`: the custom error when `condition` is false.
#[inline(always)]
pub fn require(condition: bool, error: WillError) -> Result {
    if condition {
        Ok(())
    } else {
        Err(error.into())
    }
}

/// Errors surfaced by Pinocchio calls (sysvars, CPI pre-checks).
impl From<ProgramError> for Error {
    #[cold]
    fn from(error: ProgramError) -> Self {
        // `ProgramError` never encodes to 0 (`Custom(0)` becomes `CUSTOM_ZERO`).
        Self(
            NonZeroU64::new(u64::from(error))
                .unwrap_or(Self::builtin(pinocchio::error::CUSTOM_ZERO).0),
        )
    }
}
