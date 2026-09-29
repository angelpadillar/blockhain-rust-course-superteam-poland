//! Validation and PDA helpers. Each documents the check it performs.

use {
    crate::{
        error::{Error, Result},
        ID,
    },
    core::slice::from_raw_parts,
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
pub const LOADER_V3_ID: Address =
    Address::from_str_const("BPFLoaderUpgradeab1e11111111111111111111111");

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

/// Reinterprets instruction arguments as an alignment-1 view. Trailing bytes
/// are ignored.
#[inline(always)]
pub fn parse<T>(args: &[u8]) -> Result<&T> {
    const { assert!(core::mem::align_of::<T>() == 1) };
    if args.len() < size_of::<T>() {
        return Err(Error::INVALID_INSTRUCTION_DATA);
    }
    // SAFETY: length checked above; `T` has alignment 1.
    Ok(unsafe { &*(args.as_ptr() as *const T) })
}

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

/// The current slot.
pub fn slot() -> Result<u64> {
    Ok(Clock::get()?.slot)
}

/// The account signed the transaction.
#[inline(always)]
pub fn check_signer(account: &AccountView) -> Result {
    if account.is_signer() {
        Ok(())
    } else {
        Err(Error::MISSING_REQUIRED_SIGNATURE)
    }
}

/// The account is writable in this instruction.
#[inline(always)]
pub fn check_writable(account: &AccountView) -> Result {
    if account.is_writable() {
        Ok(())
    } else {
        Err(Error::IMMUTABLE)
    }
}

/// A signer that pays: signed and writable.
pub fn check_payer(account: &AccountView) -> Result {
    check_signer(account)?;
    check_writable(account)
}

/// The account is the expected program or fixed address.
#[inline(always)]
pub fn check_address(account: &AccountView, expected: &Address) -> Result {
    if account.address() == expected {
        Ok(())
    } else {
        Err(Error::INCORRECT_PROGRAM_ID)
    }
}

/// An initialized SPL Token mint.
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

/// An initialized SPL Token account of `mint`. Returns its owner.
pub fn token_account_owner<'a>(account: &'a AccountView, mint: &Address) -> Result<&'a Address> {
    if !account.owned_by(&TOKEN_PROGRAM_ID) || account.data_len() != TOKEN_ACCOUNT_LEN {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    // SAFETY: length checked; the view has alignment 1.
    let token = unsafe { &*(account.data_ptr() as *const TokenAccount) };
    if token.state == 0 {
        return Err(Error::UNINITIALIZED_ACCOUNT);
    }
    if &token.mint != mint {
        return Err(Error::INVALID_ACCOUNT_DATA);
    }
    Ok(&token.owner)
}

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

/// The canonical PDA of `seeds` and its bump, as the runtime derives it.
#[cfg(any(target_os = "solana", target_arch = "bpf"))]
fn find_pda(seeds: &[&[u8]]) -> Result<(Address, u8)> {
    Address::try_find_program_address(seeds, &ID).ok_or(Error::INVALID_SEEDS)
}

#[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
fn find_pda(_seeds: &[&[u8]]) -> Result<(Address, u8)> {
    Err(Error::INVALID_SEEDS)
}

/// Creates the canonical PDA of `seeds` (at most three) owned by `owner`,
/// paid by `payer`. A pre-funded address is topped up, allocated and assigned
/// instead, so nobody can block creation by sending lamports to it. Fails if
/// the account already exists. Returns the bump.
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
        // Pre-funded address: top up, then allocate and assign.
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
        let pda = core::slice::from_ref(&pda);
        let allocate = Amount {
            tag: [8, 0, 0, 0],
            value: space,
        };
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
pub fn invoke(
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

/// `a * b`, or `None` on overflow, without the 128-bit multiply routine that
/// `checked_mul` pulls in on SBF.
#[inline(always)]
pub fn mul(a: u64, b: u64) -> Option<u64> {
    if b != 0 && a > u64::MAX / b {
        None
    } else {
        Some(a.wrapping_mul(b))
    }
}

/// Rent-exempt minimum for `space` bytes under either rent model: SIMD-0194/
/// SIMD-0437 (threshold 1.0, live on devnet and mainnet) or the legacy 2-year
/// threshold (litesvm, older validators). Any other threshold fails closed.
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

/// Balance of an already validated token account (re-read after CPIs).
#[inline(always)]
pub fn token_amount(account: &AccountView) -> u64 {
    // SAFETY: only called after `token_account_owner` validated the account.
    u64::from_le_bytes(unsafe { (*(account.data_ptr() as *const TokenAccount)).amount })
}

/// The same account may not fill two writable slots.
pub fn check_distinct(a: &AccountView, b: &AccountView) -> Result {
    if a.address() == b.address() {
        Err(Error::INVALID_ARGUMENT)
    } else {
        Ok(())
    }
}

/// SPL Token `Transfer`.
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

/// SPL Token `InitializeAccount3`.
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

/// SPL Token `CloseAccount`: the (empty) account's rent goes to `destination`.
pub fn token_close(
    account: &AccountView,
    destination: &AccountView,
    authority: &AccountView,
    signers: &[Signer],
) -> Result {
    let metas = [
        InstructionAccount::writable(account.address()),
        InstructionAccount::writable(destination.address()),
        InstructionAccount::readonly_signer(authority.address()),
    ];
    invoke(
        &TOKEN_PROGRAM_ID,
        &metas,
        &[account, destination, authority],
        &[9],
        signers,
    )
}
