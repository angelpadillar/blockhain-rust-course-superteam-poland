//! release_for_purchase: only the approved amount, only to allowlisted funding.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_signer::Signer,
    will_escrow::{error::WillError, state::status, Address},
};

fn setup() -> (Harness, Address) {
    let mut h = Harness::new();
    h.init_config();
    let job = h.approved_job(1, 20 * USDC);
    (h, job)
}

#[test]
fn release_to_allowlisted_altitude() {
    let (mut h, job) = setup();
    h.release(&job, 12 * USDC).unwrap();
    assert_eq!(h.token_balance(&h.funding), 12 * USDC);
    assert_eq!(h.token_balance(&vault_address(&job)), 21 * USDC - 12 * USDC);
    let state = h.job(&job);
    assert_eq!(
        (state.status, state.released.get()),
        (status::RELEASED, 12 * USDC)
    );
}

#[test]
fn release_to_other_account_rejected() {
    let (mut h, job) = setup();
    let operator = copy(&h.operator);
    for destination in [
        h.stranger_token,
        h.other_mint_funding,
        h.operator_token,
        vault_address(&job),
    ] {
        let instruction = h.release_ix(&job, destination, operator.pubkey(), USDC);
        assert_eq!(
            custom_error(&h.send(instruction, &[&operator])),
            Some(WillError::FundingNotAllowed as u32)
        );
    }
    assert_eq!(h.job(&job).released.get(), 0);
}

#[test]
fn release_by_non_operator_rejected() {
    let (mut h, job) = setup();
    for outsider in [copy(&h.customer), copy(&h.stranger), copy(&h.admin)] {
        let instruction = h.release_ix(&job, h.funding, outsider.pubkey(), USDC);
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotOperator as u32)
        );
    }
}

#[test]
fn release_over_cap_rejected() {
    let (mut h, job) = setup();
    assert_eq!(
        custom_error(&h.release(&job, 15 * USDC + 1)),
        Some(WillError::CapExceeded as u32)
    );
    assert_eq!(
        custom_error(&h.release(&job, u64::MAX)),
        Some(WillError::CapExceeded as u32)
    );
    assert_eq!(
        custom_error(&h.release(&job, 0)),
        Some(WillError::BadAmount as u32)
    );
}

#[test]
fn release_keeps_fee_reserve_locked() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.create_job(1, 15 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    h.approve(&job).unwrap();
    h.release(&job, 15 * USDC).unwrap();
    let reserve = h.job(&job).fee_reserve.get();
    assert_eq!(h.token_balance(&vault_address(&job)), reserve);
    assert!(reserve > 0);
}

#[test]
fn second_release_tops_up_to_cap() {
    let (mut h, job) = setup();
    h.release(&job, 12 * USDC).unwrap();
    h.release(&job, 3 * USDC).unwrap();
    assert_eq!(h.job(&job).released.get(), 15 * USDC);
    assert_eq!(
        custom_error(&h.release(&job, 1)),
        Some(WillError::CapExceeded as u32)
    );
}

#[test]
fn first_release_requires_live_quote_but_top_up_does_not() {
    let (mut h, job) = setup();
    let expiry = h.job(&job).quote_expires_at.get();
    h.set_time(expiry);
    assert_eq!(
        custom_error(&h.release(&job, USDC)),
        Some(WillError::QuoteExpired as u32)
    );

    let (mut h, job) = setup();
    h.release(&job, 12 * USDC).unwrap();
    h.set_time(h.job(&job).quote_expires_at.get() + 60);
    h.release(&job, 3 * USDC).unwrap();
}

#[test]
fn release_before_approval_rejected() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.create_job(1, 20 * USDC);
    assert_eq!(
        custom_error(&h.release(&job, USDC)),
        Some(WillError::BadState as u32)
    );
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    assert_eq!(
        custom_error(&h.release(&job, USDC)),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn release_when_paused_rejected() {
    let (mut h, job) = setup();
    h.set_paused(true);
    assert_eq!(
        custom_error(&h.release(&job, USDC)),
        Some(WillError::Paused as u32)
    );
    h.set_paused(false);
    h.release(&job, USDC).unwrap();
}

#[test]
fn allowlisted_funding_recreated_with_other_mint_rejected() {
    // A funding address that later holds another mint's account is refused by
    // the program itself, not only by the token program's mint check.
    let (mut h, job) = setup();
    let mut funding = h.account(&h.funding).unwrap();
    funding.data[0..32].copy_from_slice(h.other_mint.as_ref());
    h.svm.set_account(h.funding, funding).unwrap();
    assert_eq!(
        custom_error(&h.release(&job, USDC)),
        Some(WillError::FundingNotAllowed as u32)
    );
}
