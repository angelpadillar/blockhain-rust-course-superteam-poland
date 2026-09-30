//! Zero-copy views of the Anchor account layouts: an 8-byte discriminator
//! followed by the packed Borsh encoding of the struct. Every field is a byte
//! array (alignment 1), so a view can be cast directly onto account data.
//! Integers are little-endian, exactly as Borsh stores them.
//!
//! Related fields that the Anchor struct stores contiguously are grouped into
//! sub-structs; the groups line up with the instruction argument order and the
//! mandate terms preimage, so those become whole-struct copies and slices.
//!
//! # Aliasing
//!
//! The loaders hand out references into account data without runtime borrow
//! tracking. That is sound here because every handler loads each account slot
//! at most once, and the three account types have distinct discriminators: if
//! one account is passed in two slots, the second typed load fails before any
//! two references to the same data exist.

use {
    crate::{
        error::{Error, Result},
        util::bytes_of,
    },
    core::mem::size_of,
    pinocchio::{AccountView, Address},
};

pub const CONFIG_DISCRIMINATOR: [u8; 8] = [155, 12, 170, 224, 30, 250, 204, 130];
pub const CAMPAIGN_DISCRIMINATOR: [u8; 8] = [50, 40, 49, 11, 157, 220, 229, 192];
pub const MANDATE_DISCRIMINATOR: [u8; 8] = [113, 216, 98, 159, 185, 63, 55, 18];

pub mod campaign_status {
    pub const FUNDED: u8 = 0;
    pub const RESEARCHED: u8 = 1;
    pub const QUOTED: u8 = 2;
    pub const APPROVED: u8 = 3;
    pub const PAYMENT_ATTEMPTED: u8 = 4;
    pub const PAYMENT_AUTHENTICATED: u8 = 5;
    pub const PURCHASED: u8 = 6;
    pub const SETTLED: u8 = 8;
    pub const CANCELLED: u8 = 9;
}

pub mod mandate_status {
    pub const ACTIVE: u8 = 0;
    pub const REVOKED: u8 = 1;
    pub const CONSUMED: u8 = 2;
}

#[repr(C)]
pub struct Config {
    pub discriminator: [u8; 8],
    pub authority: Address,
    pub treasury: Address,
    pub research_oracle: Address,
    pub delivery_oracle: Address,
    pub allowed_mint: Address,
    pub fee_bps: [u8; 2],
    pub bump: u8,
}

/// `quote_version`, `job_kind`, `adapter`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuoteKind {
    pub quote_version: [u8; 4],
    pub job_kind: u8,
    pub adapter: u8,
}

/// `spec_hash`, `quote_hash`, `merchant_hash`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuoteCommitments {
    pub spec_hash: [u8; 32],
    pub quote_hash: [u8; 32],
    pub merchant_hash: [u8; 32],
}

/// `currency`, `currency_exponent`, `charge_currency`, `charge_currency_exponent`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuoteCurrencies {
    pub currency: [u8; 3],
    pub currency_exponent: u8,
    pub charge_currency: [u8; 3],
    pub charge_currency_exponent: u8,
}

/// The eleven quoted `u64` amounts, `item_subtotal_minor` through
/// `settlement_units_per_charge_unit_micros`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuoteAmounts {
    pub item_subtotal_minor: [u8; 8],
    pub small_order_fee_minor: [u8; 8],
    pub service_fee_minor: [u8; 8],
    pub delivery_fee_minor: [u8; 8],
    pub tip_minor: [u8; 8],
    pub other_fees_minor: [u8; 8],
    pub landed_total_minor: [u8; 8],
    pub max_total_minor: [u8; 8],
    pub settlement_amount: [u8; 8],
    pub quoted_charge_amount_minor: [u8; 8],
    pub settlement_units_per_charge_unit_micros: [u8; 8],
}

/// `quote_captured_at`, `quote_expires_at`.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct QuoteWindow {
    pub captured_at: [u8; 8],
    pub expires_at: [u8; 8],
}

#[repr(C)]
pub struct Campaign {
    pub discriminator: [u8; 8],
    pub sender: Address,
    pub mandate: Address,
    pub nonce: [u8; 8],
    pub budget: [u8; 8],
    pub spent: [u8; 8],
    pub research_hash: [u8; 32],
    pub gift_hash: [u8; 32],
    pub pod_hash: [u8; 32],
    pub commitments: QuoteCommitments,
    pub payment_attempt_hash: [u8; 32],
    pub payment_auth_hash: [u8; 32],
    pub purchase_hash: [u8; 32],
    pub order_id_hash: [u8; 32],
    pub fulfillment_hash: [u8; 32],
    pub kind: QuoteKind,
    pub currencies: QuoteCurrencies,
    pub amounts: QuoteAmounts,
    pub authenticated_amount_minor: [u8; 8],
    pub charged_amount_minor: [u8; 8],
    pub window: QuoteWindow,
    pub payment_attempted_at: [u8; 8],
    pub payment_authenticated_at: [u8; 8],
    pub purchased_at: [u8; 8],
    pub created_at: [u8; 8],
    pub expires_at: [u8; 8],
    pub status: u8,
    pub vault_bump: u8,
    pub bump: u8,
}

/// `campaign`, `sender`, `executor`.
#[repr(C)]
pub struct MandateParties {
    pub campaign: Address,
    pub sender: Address,
    pub executor: Address,
}

/// The sender-signed limits, `merchant_hash` through `expires_at`. Identical to
/// the tail of the `authorize_mandate` arguments.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MandateTerms {
    pub merchant_hash: [u8; 32],
    pub spec_hash: [u8; 32],
    pub recipient_hash: [u8; 32],
    pub charge_currency: [u8; 3],
    pub charge_currency_exponent: u8,
    pub max_charge_amount_minor: [u8; 8],
    pub max_escrow_debit: [u8; 8],
    pub expires_at: [u8; 8],
}

#[repr(C)]
pub struct Mandate {
    pub discriminator: [u8; 8],
    pub parties: MandateParties,
    pub terms: MandateTerms,
    pub status: u8,
    pub approved_terms_hash: [u8; 32],
    pub consumed_at: [u8; 8],
    pub bump: u8,
}

// Sizes are `8 + INIT_SPACE` of the Anchor structs; a layout drift fails the build.
const _: () = assert!(size_of::<Config>() == 171);
const _: () = assert!(size_of::<Campaign>() == 625);
const _: () = assert!(size_of::<Mandate>() == 270);
const _: () = assert!(core::mem::offset_of!(Campaign, kind) == 448);
const _: () = assert!(core::mem::offset_of!(Campaign, status) == 622);
const _: () = assert!(core::mem::offset_of!(Mandate, status) == 228);

/// Anchor `Account<'info, T>`: owned by this program, large enough, and tagged
/// with `T`'s discriminator.
///
/// # Safety
///
/// No other reference to the account's data may be used while the returned
/// one is live (see the module docs).
#[allow(clippy::mut_from_ref)]
#[inline(always)]
unsafe fn load<'a, T>(account: &'a AccountView, discriminator: &[u8; 8]) -> Result<&'a mut T> {
    if !account.owned_by(&crate::ID) {
        return Err(Error::INVALID_ACCOUNT_OWNER);
    }
    if account.data_len() < size_of::<T>() {
        return Err(Error::ACCOUNT_DATA_TOO_SMALL);
    }
    let data = account.data_ptr() as *mut u8;
    // SAFETY: the length check above covers the discriminator and `T`, which has
    // alignment 1.
    unsafe {
        if *(data as *const [u8; 8]) != *discriminator {
            return Err(Error::INVALID_ACCOUNT_DATA);
        }
        Ok(&mut *(data as *mut T))
    }
}

impl Config {
    /// `#[account(seeds = [CONFIG_SEED], bump = config.bump)] Account<Config>`.
    pub fn load(account: &AccountView) -> Result<&Config> {
        // SAFETY: shared view; see the module docs on aliasing.
        let config: &Config = unsafe { load(account, &CONFIG_DISCRIMINATOR)? };
        crate::util::check_pda(account, [crate::CONFIG_SEED, &[config.bump], &[], &[]])?;
        Ok(config)
    }
}

impl Campaign {
    /// `#[account(mut)] Account<Campaign>`. Call at most once per account per
    /// instruction (see the module docs).
    #[allow(clippy::mut_from_ref)]
    pub fn load_mut(account: &AccountView) -> Result<&mut Campaign> {
        crate::util::check_writable(account)?;
        // SAFETY: see the module docs on aliasing.
        unsafe { load(account, &CAMPAIGN_DISCRIMINATOR) }
    }

    /// `Account<Campaign>` without `mut`.
    pub fn load(account: &AccountView) -> Result<&Campaign> {
        // SAFETY: shared view; see the module docs on aliasing.
        unsafe { load(account, &CAMPAIGN_DISCRIMINATOR).map(|campaign| &*campaign) }
    }

    /// `load_mut` plus `seeds = [CAMPAIGN_SEED, sender, nonce], bump = campaign.bump`.
    #[allow(clippy::mut_from_ref)]
    pub fn load_escrow(account: &AccountView) -> Result<&mut Campaign> {
        let campaign = Self::load_mut(account)?;
        crate::util::check_pda(
            account,
            [
                crate::CAMPAIGN_SEED,
                campaign.sender.as_ref(),
                &campaign.nonce,
                &[campaign.bump],
            ],
        )?;
        Ok(campaign)
    }

    #[inline(always)]
    pub fn has_mandate(&self) -> bool {
        self.mandate != Address::default()
    }

    /// Bytes of `quote_version .. charge_currency_exponent` in quote-hash order.
    #[inline(always)]
    pub fn kind_bytes(&self) -> &[u8] {
        bytes_of(&self.kind)
    }
}

impl Mandate {
    /// `Account<Mandate>`; callers then apply the field's constraints in
    /// Anchor order (`seeds`, `mut`, `has_one`) via [`Mandate::check_pda`].
    /// Call at most once per account per instruction (see the module docs).
    #[allow(clippy::mut_from_ref)]
    pub fn load(account: &AccountView) -> Result<&mut Mandate> {
        // SAFETY: see the module docs on aliasing.
        unsafe { load(account, &MANDATE_DISCRIMINATOR) }
    }

    /// `#[account(mut, seeds = [MANDATE_SEED, campaign], bump = mandate.bump)]`.
    pub fn check_pda(&self, account: &AccountView, campaign: &AccountView) -> Result {
        crate::util::check_pda(
            account,
            [
                crate::MANDATE_SEED,
                campaign.address().as_ref(),
                &[self.bump],
                &[],
            ],
        )?;
        crate::util::check_writable(account)
    }
}
