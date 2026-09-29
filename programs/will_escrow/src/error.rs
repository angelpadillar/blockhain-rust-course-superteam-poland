use core::num::NonZeroU64;

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

    /// The value the entrypoint returns to the runtime.
    #[inline(always)]
    pub fn code(self) -> u64 {
        self.0.get()
    }
}
