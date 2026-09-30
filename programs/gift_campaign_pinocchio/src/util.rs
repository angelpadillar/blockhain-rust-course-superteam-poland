//! Account validation, PDA, CPI and event helpers. Each helper documents the
//! Anchor constraint it replaces.

use {
    crate::{
        error::{require, Error, GiftCampaignError, Result},
        ID,
    },
    core::{mem::size_of, slice::from_raw_parts},
    pinocchio::{
        cpi::{invoke_signed_with_bounds, Seed, Signer},
        instruction::{InstructionAccount, InstructionView},
        sysvars::{
            clock::Clock,
            get_sysvar,
            rent::{ACCOUNT_STORAGE_OVERHEAD, RENT_ID},
            Sysvar,
        },
        AccountView, Address,
    },
};

pub const TOKEN_PROGRAM_ID: Address =
    Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM_ID: Address = Address::new_from_array([0; 32]);

const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";
const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;

/// SPL Token account prefix (`mint`, `owner`, `amount`, `delegate`, `state`).
#[repr(C)]
struct TokenAccount {
    mint: Address,
    owner: Address,
    amount: [u8; 8],
    delegate: [u8; 36],
    state: u8,
}

/// The raw bytes of a `#[repr(C)]` view made only of byte arrays.
#[inline(always)]
pub fn bytes_of<T>(value: &T) -> &[u8] {
    // SAFETY: callers only pass alignment-1 structs of byte arrays (no padding).
    unsafe { from_raw_parts(value as *const T as *const u8, size_of::<T>()) }
}

/// Reinterprets instruction arguments as an alignment-1 view. Like Anchor's
/// Borsh decoding, trailing bytes are ignored.
#[inline(always)]
pub fn parse<T>(args: &[u8]) -> Result<&T> {
    const { assert!(core::mem::align_of::<T>() == 1) };
    if args.len() < size_of::<T>() {
        return Err(Error::INVALID_INSTRUCTION_DATA);
    }
    // SAFETY: length checked above; `T` has alignment 1.
    Ok(unsafe { &*(args.as_ptr() as *const T) })
}

#[inline(always)]
pub fn u64_le(bytes: &[u8; 8]) -> u64 {
    u64::from_le_bytes(*bytes)
}

#[inline(always)]
pub fn i64_le(bytes: &[u8; 8]) -> i64 {
    i64::from_le_bytes(*bytes)
}

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// `Signer<'info>`.
#[inline(always)]
pub fn check_signer(account: &AccountView) -> Result {
    if account.is_signer() {
        Ok(())
    } else {
        Err(Error::MISSING_REQUIRED_SIGNATURE)
    }
}

/// `#[account(mut)]`.
#[inline(always)]
pub fn check_writable(account: &AccountView) -> Result {
    if account.is_writable() {
        Ok(())
    } else {
        Err(Error::IMMUTABLE)
    }
}

/// `#[account(mut)] Signer<'info>` (payers).
pub fn check_payer(account: &AccountView) -> Result {
    check_signer(account)?;
    check_writable(account)
}

/// `Program<'info, T>` / `address = ...`.
#[inline(always)]
pub fn check_address(account: &AccountView, expected: &Address) -> Result {
    if account.address() == expected {
        Ok(())
    } else {
        Err(Error::INCORRECT_PROGRAM_ID)
    }
}

/// `SystemAccount<'info>`.
pub fn check_system_account(account: &AccountView) -> Result {
    if account.owned_by(&SYSTEM_PROGRAM_ID) {
        Ok(())
    } else {
        Err(Error::INVALID_ACCOUNT_OWNER)
    }
}

/// `Account<'info, Mint>`: owned by SPL Token, mint-sized and initialized.
pub fn check_mint(account: &AccountView) -> Result {
    if !account.owned_by(&TOKEN_PROGRAM_ID) || account.data_len() != MINT_LEN {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    // SAFETY: length checked; `is_initialized` is byte 45 of the mint layout.
    if unsafe { *account.data_ptr().add(45) } != 1 {
        return Err(Error::UNINITIALIZED_ACCOUNT);
    }
    Ok(())
}

/// `#[account(mut, token::mint = mint, token::authority = owner)] Account<'info, TokenAccount>`.
pub fn check_token_account(account: &AccountView, mint: &Address, owner: &Address) -> Result {
    check_writable(account)?;
    if !account.owned_by(&TOKEN_PROGRAM_ID) || account.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    // SAFETY: length checked; the view has alignment 1.
    let token = unsafe { &*(account.data_ptr() as *const TokenAccount) };
    if token.state == 0 {
        return Err(Error::UNINITIALIZED_ACCOUNT);
    }
    if &token.mint != mint || &token.owner != owner {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    Ok(())
}

/// Current balance of an already validated token account (always re-read, so
/// it reflects preceding CPIs like Anchor's `reload()`).
#[inline(always)]
pub fn token_amount(account: &AccountView) -> u64 {
    // SAFETY: only called after `check_token_account`.
    u64_le(unsafe { &(*(account.data_ptr() as *const TokenAccount)).amount })
}

/// Anchor 1.x rejects the same account in two mutable `Account<T>` slots.
pub fn check_distinct(a: &AccountView, b: &AccountView) -> Result {
    if a.address() == b.address() {
        Err(Error::INVALID_ARGUMENT)
    } else {
        Ok(())
    }
}

/// `seeds = [...], bump = stored_bump`. `seeds` includes the bump; unused
/// trailing entries are empty and do not change the SHA-256 preimage.
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

/// `seeds = [...], bump` on `init`: the canonical bump, as Anchor derives it.
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn find_pda(seeds: &[&[u8]]) -> Result<(Address, u8)> {
    Address::try_find_program_address(seeds, &ID).ok_or(Error::INVALID_SEEDS)
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
fn find_pda(_seeds: &[&[u8]]) -> Result<(Address, u8)> {
    Err(Error::INVALID_SEEDS)
}

/// `#[account(init, payer, space, seeds = [...], bump)]`: checks the address is
/// the canonical PDA of `seeds` (at most three), then creates it owned by
/// `owner`. A pre-funded address is topped up, allocated and assigned instead,
/// as Anchor does. Returns the bump.
pub fn init_pda(
    account: &mut AccountView,
    payer: &AccountView,
    owner: &Address,
    space: usize,
    seeds: &[&[u8]],
) -> Result<u8> {
    check_writable(account)?;
    let (address, bump) = find_pda(seeds)?;
    if &address != account.address() {
        return Err(Error::INVALID_SEEDS);
    }
    let bump_seed = [bump];
    // `seeds` followed by the bump; entries past it are never read.
    let signer_seeds: [Seed; 4] =
        core::array::from_fn(|i| Seed::from(seeds.get(i).copied().unwrap_or(&bump_seed)));
    let signer_seeds = signer_seeds
        .get(..=seeds.len())
        .ok_or(Error::INVALID_SEEDS)?;
    let signer = [Signer::from(signer_seeds)];

    let account = &*account;
    let lamports = minimum_balance(space)?;
    let current = account.lamports();
    let space = (space as u64).to_le_bytes();
    let pda = InstructionAccount::writable_signer(account.address());
    if current == 0 {
        #[repr(C)]
        struct CreateAccount {
            tag: [u8; 4],
            lamports: [u8; 8],
            space: [u8; 8],
            owner: Address,
        }
        let data = CreateAccount {
            tag: [0; 4],
            lamports: lamports.to_le_bytes(),
            space,
            owner: *owner,
        };
        let metas = [InstructionAccount::writable_signer(payer.address()), pda];
        invoke(
            &SYSTEM_PROGRAM_ID,
            &metas,
            &[payer, account],
            bytes_of(&data),
            &signer,
        )?;
    } else {
        // Someone pre-funded the address: top up, then allocate and assign.
        #[repr(C)]
        struct Amount {
            tag: [u8; 4],
            value: [u8; 8],
        }
        #[repr(C)]
        struct Assign {
            tag: [u8; 4],
            owner: Address,
        }
        let shortfall = lamports.saturating_sub(current);
        if shortfall > 0 {
            let data = Amount {
                tag: [2, 0, 0, 0],
                value: shortfall.to_le_bytes(),
            };
            let metas = [
                InstructionAccount::writable_signer(payer.address()),
                InstructionAccount::writable(account.address()),
            ];
            invoke(
                &SYSTEM_PROGRAM_ID,
                &metas,
                &[payer, account],
                bytes_of(&data),
                &[],
            )?;
        }
        let allocate = Amount {
            tag: [8, 0, 0, 0],
            value: space,
        };
        let pda = core::slice::from_ref(&pda);
        invoke(
            &SYSTEM_PROGRAM_ID,
            pda,
            &[account],
            bytes_of(&allocate),
            &signer,
        )?;
        let assign = Assign {
            tag: [1, 0, 0, 0],
            owner: *owner,
        };
        invoke(
            &SYSTEM_PROGRAM_ID,
            pda,
            &[account],
            bytes_of(&assign),
            &signer,
        )?;
    }
    Ok(bump)
}

/// The single CPI path for every system and token call (at most three
/// accounts), so the account marshalling code exists once in the binary.
#[inline(never)]
fn invoke(
    program_id: &Address,
    metas: &[InstructionAccount],
    views: &[&AccountView],
    data: &[u8],
    signers: &[Signer],
) -> Result {
    let instruction = InstructionView {
        program_id,
        accounts: metas,
        data,
    };
    Ok(invoke_signed_with_bounds::<3, &AccountView>(
        &instruction,
        views,
        signers,
    )?)
}

/// Rent-exempt minimum for `space` bytes under either rent model: SIMD-0194
/// (exemption threshold 1.0, live on devnet and mainnet) or the legacy 2-year
/// threshold still used by litesvm and older local validators. Any other
/// threshold fails closed instead of pulling in soft-float code.
fn minimum_balance(space: usize) -> Result<u64> {
    const THRESHOLD_1: u64 = 0x3ff0_0000_0000_0000; // 1.0f64
    const THRESHOLD_2: u64 = 0x4000_0000_0000_0000; // 2.0f64
                                                    // Rent sysvar prefix: `lamports_per_byte(_year): u64`, `exemption_threshold: f64`.
    let mut rent = [[0u8; 8]; 2];
    get_sysvar(rent.as_flattened_mut(), &RENT_ID, 0)?;
    let [per_byte, threshold] = rent.map(u64::from_le_bytes);
    let base = ACCOUNT_STORAGE_OVERHEAD
        .checked_add(space as u64)
        .and_then(|bytes| mul(bytes, per_byte))
        .ok_or(Error::ARITHMETIC_OVERFLOW)?;
    match threshold {
        THRESHOLD_1 => Ok(base),
        THRESHOLD_2 => base.checked_add(base).ok_or(Error::ARITHMETIC_OVERFLOW),
        _ => Err(Error::UNSUPPORTED_SYSVAR),
    }
}

/// SPL Token `Transfer` (the instruction `anchor_spl::token::transfer` builds).
pub fn token_transfer(
    from: &AccountView,
    to: &AccountView,
    authority: &AccountView,
    amount: u64,
    signers: &[Signer],
) -> Result {
    let [a0, a1, a2, a3, a4, a5, a6, a7] = amount.to_le_bytes();
    let data = [3, a0, a1, a2, a3, a4, a5, a6, a7];
    let metas = [
        InstructionAccount::writable(from.address()),
        InstructionAccount::writable(to.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    invoke(
        &TOKEN_PROGRAM_ID,
        &metas,
        &[from, to, authority],
        &data,
        signers,
    )
}

/// SPL Token `InitializeAccount3` (what Anchor's `token::` init constraint uses).
pub fn token_initialize_account(
    account: &AccountView,
    mint: &AccountView,
    owner: &Address,
) -> Result {
    #[repr(C)]
    struct Data {
        tag: u8,
        owner: Address,
    }
    let data = Data {
        tag: 18,
        owner: *owner,
    };
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::readonly(mint.address()),
    ];
    invoke(
        &TOKEN_PROGRAM_ID,
        &metas,
        &[account, mint],
        bytes_of(&data),
        &[],
    )
}

/// `a * b`, or `None` on overflow. Same result as `checked_mul`, without the
/// 128-bit multiply routine that `checked_mul` pulls in on SBF.
#[inline(always)]
pub fn mul(a: u64, b: u64) -> Option<u64> {
    if b != 0 && a > u64::MAX / b {
        None
    } else {
        Some(a.wrapping_mul(b))
    }
}

/// Protocol fee: `amount * fee_bps / 10_000`, failing on overflow.
pub fn fee_for(amount: u64, fee_bps: &[u8; 2]) -> Result<u64> {
    mul(amount, u64::from(u16::from_le_bytes(*fee_bps)))
        .map(|product| product / crate::BASIS_POINTS_DENOMINATOR)
        .ok_or_else(|| GiftCampaignError::ArithmeticOverflow.into())
}

/// `settlement_amount + fee`, the exact escrow debit of a quote.
pub fn escrow_debit(settlement_amount: u64, fee_bps: &[u8; 2]) -> Result<u64> {
    settlement_amount
        .checked_add(fee_for(settlement_amount, fee_bps)?)
        .ok_or_else(|| GiftCampaignError::ArithmeticOverflow.into())
}

#[inline(always)]
pub fn is_zero(hash: &[u8; 32]) -> bool {
    *hash == [0; 32]
}

/// Rejects an all-zero commitment.
#[inline(always)]
pub fn require_hash(hash: &[u8; 32]) -> Result {
    require(!is_zero(hash), GiftCampaignError::ZeroHash)
}

/// Upper-case ASCII currency code with at most four minor-unit digits.
pub fn is_supported_currency(code: &[u8; 3], exponent: u8) -> bool {
    code.iter().all(u8::is_ascii_uppercase) && exponent <= 4
}

/// Anchor `emit!`: `sol_log_data` of the event discriminator followed by the
/// Borsh-encoded fields, logged as one `Program data:` entry.
pub fn emit<T>(event: &T) {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let data = [bytes_of(event)];
        // SAFETY: `data` is a valid slice of byte slices for the duration of the call.
        unsafe { pinocchio::syscalls::sol_log_data(data.as_ptr() as *const u8, 1) };
    }
    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    let _ = event;
}
