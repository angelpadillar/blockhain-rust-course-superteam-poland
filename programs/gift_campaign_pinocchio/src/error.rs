use {core::num::NonZeroU64, pinocchio::error as builtin, pinocchio::error::ProgramError};

/// Same numbering as the Anchor `#[error_code]` enum (first variant = 6000), so
/// clients observe identical `custom program error` codes from both binaries.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum GiftCampaignError {
    FeeTooHigh = 6000,
    InvalidBudget,
    InvalidExpiry,
    InvalidCampaignState,
    ZeroHash,
    UnauthorizedResearchOracle,
    UnauthorizedDeliveryOracle,
    UnauthorizedSender,
    UnauthorizedCancellation,
    CampaignExpired,
    ArithmeticOverflow,
    UnauthorizedFulfillmentOracle,
    QuoteTotalMismatch,
    QuoteExceedsMaximum,
    QuoteExpired,
    QuoteMismatch,
    PaymentMismatch,
    UnsupportedCurrency,
    InsufficientEscrowBudget,
    MandateRequired,
    MandateMismatch,
    InactiveMandate,
    MandateExpired,
    UnauthorizedExecutor,
    MandateLimitExceeded,
    TermsMismatch,
    LegacyPathForbidden,
}

/// A program error in its final `u64` entrypoint encoding. Unlike
/// `ProgramError`, `Result<(), Error>` fits in one register, which keeps the
/// many `?` sites small.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(transparent)]
pub struct Error(NonZeroU64);

pub type Result<T = ()> = core::result::Result<T, Error>;

impl Error {
    const fn builtin(code: u64) -> Self {
        match NonZeroU64::new(code) {
            Some(code) => Self(code),
            None => panic!("builtin error codes are non-zero"),
        }
    }

    pub const INVALID_ARGUMENT: Self = Self::builtin(builtin::INVALID_ARGUMENT);
    pub const INVALID_INSTRUCTION_DATA: Self = Self::builtin(builtin::INVALID_INSTRUCTION_DATA);
    pub const INVALID_ACCOUNT_DATA: Self = Self::builtin(builtin::INVALID_ACCOUNT_DATA);
    pub const ACCOUNT_DATA_TOO_SMALL: Self = Self::builtin(builtin::ACCOUNT_DATA_TOO_SMALL);
    pub const INCORRECT_PROGRAM_ID: Self = Self::builtin(builtin::INCORRECT_PROGRAM_ID);
    pub const MISSING_REQUIRED_SIGNATURE: Self =
        Self::builtin(builtin::MISSING_REQUIRED_SIGNATURES);
    pub const UNINITIALIZED_ACCOUNT: Self = Self::builtin(builtin::UNINITIALIZED_ACCOUNT);
    pub const NOT_ENOUGH_ACCOUNT_KEYS: Self = Self::builtin(builtin::NOT_ENOUGH_ACCOUNT_KEYS);
    pub const INVALID_SEEDS: Self = Self::builtin(builtin::INVALID_SEEDS);
    pub const UNSUPPORTED_SYSVAR: Self = Self::builtin(builtin::UNSUPPORTED_SYSVAR);
    pub const INVALID_ACCOUNT_OWNER: Self = Self::builtin(builtin::INVALID_ACCOUNT_OWNER);
    pub const ARITHMETIC_OVERFLOW: Self = Self::builtin(builtin::ARITHMETIC_OVERFLOW);
    pub const IMMUTABLE: Self = Self::builtin(builtin::IMMUTABLE);

    /// The value the entrypoint returns to the runtime.
    #[inline(always)]
    pub fn code(self) -> u64 {
        self.0.get()
    }
}

impl From<GiftCampaignError> for Error {
    #[inline(always)]
    fn from(error: GiftCampaignError) -> Self {
        const _: () = assert!(GiftCampaignError::FeeTooHigh as u32 != 0);
        // SAFETY: every variant is >= 6000.
        Self(unsafe { NonZeroU64::new_unchecked(error as u64) })
    }
}

/// Errors surfaced by Pinocchio calls (sysvars, CPI pre-checks).
impl From<ProgramError> for Error {
    #[cold]
    fn from(error: ProgramError) -> Self {
        // `ProgramError` never encodes to 0 (`Custom(0)` becomes `CUSTOM_ZERO`).
        Self(NonZeroU64::new(u64::from(error)).unwrap_or(Self::builtin(builtin::CUSTOM_ZERO).0))
    }
}

/// `require!` equivalent: returns the custom error when `condition` is false.
#[inline(always)]
pub fn require(condition: bool, error: GiftCampaignError) -> Result {
    if condition {
        Ok(())
    } else {
        Err(error.into())
    }
}
