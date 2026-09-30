//! record_purchase: the charge is bounded by what was released, and anything
//! released but unspent returns to the vault in the same instruction.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_signer::Signer,
    will_escrow::{error::WillError, state::status, Address},
};

/// Budget 20 USDC (+1 fee reserve), quote approved, 15 USDC released.
fn released() -> (Harness, Address) {
    let mut h = Harness::new();
    h.init_config();
    let job = h.approved_job(1, 20 * USDC);
    h.release(&job, 15 * USDC).unwrap();
    (h, job)
}

#[test]
fn record_returns_excess_to_vault() {
    let (mut h, job) = released();
    let operator_before = h.token_balance(&h.operator_token);
    h.record(&job, 13_500_000).unwrap();
    assert_eq!(
        h.token_balance(&h.operator_token),
        operator_before - 1_500_000
    );
    assert_eq!(
        h.token_balance(&vault_address(&job)),
        21 * USDC - 13_500_000
    );
    let state = h.job(&job);
    assert_eq!(state.status, status::PURCHASED);
    assert_eq!(
        (state.charged.get(), state.charged_quote_amount.get()),
        (13_500_000, 5_398)
    );
    assert_eq!(state.order_ref_hash, [5; 32]);
}

#[test]
fn record_exact_charge_returns_nothing() {
    let (mut h, job) = released();
    let operator_before = h.token_balance(&h.operator_token);
    h.record(&job, 15 * USDC).unwrap();
    assert_eq!(h.token_balance(&h.operator_token), operator_before);
    assert_eq!(h.token_balance(&vault_address(&job)), 6 * USDC);
}

#[test]
fn record_rejects_charge_over_released() {
    let (mut h, job) = released();
    assert_eq!(
        custom_error(&h.record(&job, 15 * USDC + 1)),
        Some(WillError::CapExceeded as u32)
    );
    assert_eq!(
        custom_error(&h.record(&job, 0)),
        Some(WillError::BadAmount as u32)
    );
    assert_eq!(h.job(&job).status, status::RELEASED);
}

#[test]
fn charge_above_release_needs_top_up() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.approved_job(1, 20 * USDC);
    h.release(&job, 12 * USDC).unwrap();
    assert_eq!(
        custom_error(&h.record(&job, 13 * USDC)),
        Some(WillError::CapExceeded as u32)
    );
    h.release(&job, USDC).unwrap();
    h.record(&job, 13 * USDC).unwrap();
}

#[test]
fn record_rejects_zero_order_ref() {
    let (mut h, job) = released();
    let instruction = h.record_ix(
        &job,
        h.operator.pubkey(),
        h.operator_token,
        [0; 32],
        15 * USDC,
        5_398,
    );
    let operator = copy(&h.operator);
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator])),
        Some(WillError::BadAmount as u32)
    );
}

#[test]
fn record_rejects_quote_amount_over_ceiling() {
    let (mut h, job) = released();
    let operator = copy(&h.operator);
    let instruction = h.record_ix(
        &job,
        operator.pubkey(),
        h.operator_token,
        [5; 32],
        15 * USDC,
        6_001,
    );
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator])),
        Some(WillError::CapExceeded as u32)
    );
    let instruction = h.record_ix(
        &job,
        operator.pubkey(),
        h.operator_token,
        [5; 32],
        15 * USDC,
        6_000,
    );
    h.send(instruction, &[&operator]).unwrap();
}

#[test]
fn record_by_non_operator_rejected() {
    let (mut h, job) = released();
    for outsider in [copy(&h.customer), copy(&h.stranger)] {
        let token = h.create_token_account(h.mint, outsider.pubkey());
        let instruction = h.record_ix(&job, outsider.pubkey(), token, [5; 32], 15 * USDC, 5_398);
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotOperator as u32)
        );
    }
}

#[test]
fn record_return_must_come_from_operator_account() {
    let (mut h, job) = released();
    let operator = copy(&h.operator);
    let instruction = h.record_ix(
        &job,
        operator.pubkey(),
        h.stranger_token,
        [5; 32],
        13 * USDC,
        5_398,
    );
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator])),
        Some(WillError::NotOperator as u32)
    );
}

#[test]
fn record_before_release_rejected() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.approved_job(1, 20 * USDC);
    assert_eq!(
        custom_error(&h.record(&job, USDC)),
        Some(WillError::BadState as u32)
    );
}
