//! Zero-copy account layouts. Every field is a byte array or a newtype over
//! one, so the structs have alignment 1 and cast directly onto account data.
//! Integers are little-endian; hashes are stored, never strings.
//!
//! # Aliasing
//!
//! Loaders hand out references into account data without runtime borrow
//! tracking. That is sound because every handler loads each account slot at
//! most once, and Config and Job carry distinct type tags: one account passed
//! in two slots fails the second typed load before two references exist.

use {
    crate::{
        error::{Error, Result},
        util::check_pda,
        ID,
    },
    pinocchio::{AccountView, Address},
};

pub const CONFIG_SEED: &[u8] = b"config";
pub const JOB_SEED: &[u8] = b"job";
pub const VAULT_SEED: &[u8] = b"vault";

pub const CONFIG_TAG: u8 = 1;
pub const JOB_TAG: u8 = 2;
pub const VERSION: u8 = 1;

/// Job lifecycle. A closed account is the terminal state.
pub mod status {
    pub const FUNDED: u8 = 0;
    pub const QUOTED: u8 = 1;
    pub const APPROVED: u8 = 2;
    pub const RELEASED: u8 = 3;
    pub const PURCHASED: u8 = 4;
    pub const PROVEN: u8 = 5;
    pub const DISPUTED: u8 = 6;
}

// Codama 0.13 drops types that carry a type-level override from the IDL, so
// every field of these types carries a field-level `number(..)` override.

/// Little-endian `u16` stored as bytes.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LeU16([u8; 2]);

/// Little-endian `u32` stored as bytes.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LeU32([u8; 4]);

/// Little-endian `u64` stored as bytes.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LeU64([u8; 8]);

/// Little-endian `i64` stored as bytes.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct LeI64([u8; 8]);

macro_rules! le_accessors {
    ($($name:ident: $int:ty),*) => {$(
        impl $name {
            #[inline(always)]
            pub fn get(self) -> $int {
                <$int>::from_le_bytes(self.0)
            }

            #[inline(always)]
            pub fn set(&mut self, value: $int) {
                self.0 = value.to_le_bytes();
            }
        }
    )*};
}

le_accessors!(LeU16: u16, LeU32: u32, LeU64: u64, LeI64: i64);

/// A 32-byte SHA-256 commitment.
pub type Hash = [u8; 32];

/// Singleton at `["config"]`, created once by the program's upgrade authority.
#[repr(C)]
#[derive(Clone, Default)]
#[cfg_attr(feature = "idl", derive(codama::CodamaAccount))]
pub struct Config {
    pub tag: u8,
    pub version: u8,
    pub bump: u8,
    pub paused: u8,
    #[cfg_attr(feature = "idl", codama(type = number(u16)))]
    pub fee_bps: LeU16,
    /// Seconds after proof during which the customer may dispute.
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub dispute_window: LeU32,
    /// Seconds after creation before an unfinished job may be refunded.
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub job_timeout: LeU32,
    /// Seconds after a dispute before an unresolved one may be refunded.
    #[cfg_attr(feature = "idl", codama(type = number(u32)))]
    pub dispute_timeout: LeU32,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub admin: Address,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub operator: Address,
    /// Owner of the fee token account.
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub treasury: Address,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub mint: Address,
    pub funding_count: u8,
    /// Allowlisted purchase-funding token accounts (Altitude deposit).
    #[cfg_attr(feature = "idl", codama(type = array(public_key, 4)))]
    pub funding: [Address; 4],
}

/// Quote line items and price ceiling, in quote-currency minor units.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[cfg_attr(feature = "idl", derive(codama::CodamaType))]
pub struct Quote {
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub item: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub service_fee: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub delivery_fee: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub tip: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub other: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub ceiling: LeU64,
}

/// One purchase at `["job", customer, job_id]`, closed when it ends.
#[repr(C)]
#[derive(Clone, Default)]
#[cfg_attr(feature = "idl", derive(codama::CodamaAccount))]
pub struct Job {
    pub tag: u8,
    pub version: u8,
    pub status: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub job_kind: u8,
    pub adapter: u8,
    pub quote_exponent: u8,
    pub quote_currency: [u8; 3],
    pub flags: u8,
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub customer: Address,
    /// Paid the job and vault rent; receives it back at close.
    #[cfg_attr(feature = "idl", codama(type = public_key))]
    pub rent_payer: Address,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub job_id: LeU64,
    /// USDC available for purchases.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub budget: LeU64,
    /// USDC held back for the fee.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub fee_reserve: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub mandate_cap: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub mandate_expires_at: LeI64,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub expires_at: LeI64,
    pub quote: Quote,
    /// Most USDC the customer approved for release to the funding account.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub release_cap: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub quote_expires_at: LeI64,
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub quote_hash: Hash,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub released: LeU64,
    /// USDC actually spent at the merchant.
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub charged: LeU64,
    #[cfg_attr(feature = "idl", codama(type = number(u64)))]
    pub charged_quote_amount: LeU64,
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub order_ref_hash: Hash,
    #[cfg_attr(feature = "idl", codama(type = fixed_size(bytes, 32)))]
    pub proof_hash: Hash,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub proof_at: LeI64,
    #[cfg_attr(feature = "idl", codama(type = number(i64)))]
    pub disputed_at: LeI64,
}

const _: () = assert!(size_of::<Config>() == 275 && align_of::<Config>() == 1);
const _: () = assert!(size_of::<Job>() == 324 && align_of::<Job>() == 1);

/// Owned by this program, at least `size_of::<T>()` bytes, and tagged `tag`.
///
/// # Safety
///
/// No other reference to the account's data may be used while the returned
/// one is live (see the module docs).
#[allow(clippy::mut_from_ref)]
unsafe fn load<T>(account: &AccountView, tag: u8) -> Result<&mut T> {
    if !account.owned_by(&ID) {
        return Err(Error::INVALID_ACCOUNT_OWNER);
    }
    if account.data_len() < size_of::<T>() {
        return Err(Error::ACCOUNT_DATA_TOO_SMALL);
    }
    let data = account.data_ptr() as *mut u8;
    // SAFETY: the length check covers `T`, which has alignment 1.
    unsafe {
        if *data != tag {
            return Err(Error::INVALID_ACCOUNT_DATA);
        }
        Ok(&mut *(data as *mut T))
    }
}

impl Config {
    /// The config PDA, checked against its stored bump.
    pub fn load(account: &AccountView) -> Result<&Config> {
        Self::load_mut(account).map(|config| &*config)
    }

    /// `load` for a writable config. Call at most once per instruction.
    #[allow(clippy::mut_from_ref)]
    pub fn load_mut(account: &AccountView) -> Result<&mut Config> {
        // SAFETY: see the module docs.
        let config: &mut Config = unsafe { load(account, CONFIG_TAG)? };
        check_pda(account, [CONFIG_SEED, &[config.bump], &[], &[]])?;
        Ok(config)
    }
}

impl Job {
    /// A job PDA, checked against the customer, id and bump it stores. Call at
    /// most once per account per instruction (see the module docs).
    #[allow(clippy::mut_from_ref)]
    pub fn load_mut(account: &AccountView) -> Result<&mut Job> {
        // SAFETY: see the module docs.
        let job: &mut Job = unsafe { load(account, JOB_TAG)? };
        check_pda(
            account,
            [JOB_SEED, job.customer.as_ref(), &job.job_id.0, &[job.bump]],
        )?;
        Ok(job)
    }
}

#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::{error::Error, test_utils::TestAccount, util::bytes_of, ID},
        core::mem::{align_of, offset_of},
        pinocchio::Address,
    };

    const CUSTOMER: Address = Address::new_from_array([7; 32]);

    fn pda(seeds: &[&[u8]]) -> Address {
        let mut all: Vec<&[u8]> = seeds.to_vec();
        all.extend([ID.as_ref(), b"ProgramDerivedAddress".as_ref()]);
        Address::new_from_array(solana_sha256_hasher::hashv(&all).to_bytes())
    }

    fn job(job_id: u64, bump: u8) -> Job {
        let mut job = Job {
            tag: JOB_TAG,
            version: VERSION,
            bump,
            customer: CUSTOMER,
            ..Job::default()
        };
        job.job_id.set(job_id);
        job
    }

    fn job_address(job_id: u64, bump: u8) -> Address {
        pda(&[JOB_SEED, CUSTOMER.as_ref(), &job_id.to_le_bytes(), &[bump]])
    }

    fn config(bump: u8) -> Config {
        Config {
            tag: CONFIG_TAG,
            version: VERSION,
            bump,
            ..Config::default()
        }
    }

    #[test]
    fn layout_sizes_and_offsets() {
        assert_eq!((size_of::<Config>(), align_of::<Config>()), (275, 1));
        assert_eq!((size_of::<Job>(), align_of::<Job>()), (324, 1));
        assert_eq!(offset_of!(Config, admin), 18);
        assert_eq!(offset_of!(Config, funding_count), 146);
        assert_eq!(offset_of!(Job, customer), 12);
        assert_eq!(offset_of!(Job, quote), 124);
        assert_eq!(offset_of!(Job, quote_hash), 188);
        assert_eq!(offset_of!(Job, disputed_at), 316);
    }

    #[test]
    fn load_accepts_the_real_job_and_config() {
        let mut job_account = TestAccount::new(job_address(42, 250), ID, bytes_of(&job(42, 250)));
        let view = job_account.view();
        assert_eq!(Job::load_mut(&view).unwrap().job_id.get(), 42);
        let mut config_account =
            TestAccount::new(pda(&[CONFIG_SEED, &[251]]), ID, bytes_of(&config(251)));
        assert_eq!(Config::load(&config_account.view()).unwrap().bump, 251);
    }

    #[test]
    fn load_rejects_wrong_owner() {
        let foreign = Address::new_from_array([9; 32]);
        let mut account = TestAccount::new(job_address(1, 250), foreign, bytes_of(&job(1, 250)));
        assert_eq!(
            Job::load_mut(&account.view()).err(),
            Some(Error::INVALID_ACCOUNT_OWNER)
        );
    }

    #[test]
    fn load_rejects_wrong_tag() {
        // A config's bytes placed at a job address must not load as a job, and vice versa.
        let mut account = TestAccount::new(job_address(1, 250), ID, bytes_of(&job(1, 250)));
        assert_eq!(
            Config::load(&account.view()).err(),
            Some(Error::INVALID_ACCOUNT_DATA)
        );
        let mut padded = bytes_of(&config(251)).to_vec();
        padded.resize(size_of::<Job>(), 0);
        let mut account = TestAccount::new(pda(&[CONFIG_SEED, &[251]]), ID, &padded);
        assert_eq!(
            Job::load_mut(&account.view()).err(),
            Some(Error::INVALID_ACCOUNT_DATA)
        );
    }

    #[test]
    fn load_rejects_short_data() {
        let job = job(1, 250);
        let bytes = &bytes_of(&job)[..size_of::<Job>() - 1];
        let mut account = TestAccount::new(job_address(1, 250), ID, bytes);
        assert_eq!(
            Job::load_mut(&account.view()).err(),
            Some(Error::ACCOUNT_DATA_TOO_SMALL)
        );
    }

    #[test]
    fn load_rejects_wrong_pda() {
        // Right owner, tag and size, but not at the address its own seeds derive.
        let mut account = TestAccount::new(job_address(2, 250), ID, bytes_of(&job(1, 250)));
        assert_eq!(
            Job::load_mut(&account.view()).err(),
            Some(Error::INVALID_SEEDS)
        );
        let mut account = TestAccount::new(pda(&[CONFIG_SEED, &[250]]), ID, bytes_of(&config(251)));
        assert_eq!(
            Config::load(&account.view()).err(),
            Some(Error::INVALID_SEEDS)
        );
    }

    #[test]
    fn integer_fields_are_little_endian() {
        let mut job = job(0, 0);
        job.budget.set(0x0102_0304_0506_0708);
        let bytes = bytes_of(&job);
        assert_eq!(&bytes[84..92], &[8, 7, 6, 5, 4, 3, 2, 1]);
        job.expires_at.set(-2);
        assert_eq!(job.expires_at.get(), -2);
    }
}
