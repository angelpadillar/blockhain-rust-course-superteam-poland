//! submit_proof starts the dispute window; the customer may dispute inside it.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_signer::Signer,
    will_escrow::{error::WillError, state::status, Address},
};

fn purchased() -> (Harness, Address) {
    let mut h = Harness::new();
    h.init_config();
    let job = h.purchased_job(1);
    (h, job)
}

#[test]
fn proof_starts_window() {
    let (mut h, job) = purchased();
    h.prove(&job).unwrap();
    let state = h.job(&job);
    assert_eq!((state.status, state.proof_hash), (status::PROVEN, [6; 32]));
    assert_eq!(
        state.window_ends_at.get(),
        h.now() + i64::from(DISPUTE_WINDOW)
    );
}

#[test]
fn proof_by_non_operator_rejected() {
    let (mut h, job) = purchased();
    for outsider in [copy(&h.customer), copy(&h.stranger)] {
        let instruction = h.proof_ix(&job, outsider.pubkey(), [6; 32]);
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotOperator as u32)
        );
    }
}

#[test]
fn proof_before_purchase_rejected() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.approved_job(1, 20 * USDC);
    h.release(&job, 15 * USDC).unwrap();
    assert_eq!(
        custom_error(&h.prove(&job)),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn proof_rejects_zero_hash() {
    let (mut h, job) = purchased();
    let instruction = h.proof_ix(&job, h.operator.pubkey(), [0; 32]);
    let operator = copy(&h.operator);
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator])),
        Some(WillError::BadAmount as u32)
    );
}

#[test]
fn dispute_within_window() {
    let (mut h, job) = purchased();
    h.prove(&job).unwrap();
    h.set_time(h.job(&job).window_ends_at.get() - 1);
    h.dispute(&job).unwrap();
    let state = h.job(&job);
    assert_eq!(state.status, status::DISPUTED);
    assert_eq!(
        state.dispute_expires_at.get(),
        h.now() + i64::from(DISPUTE_TIMEOUT)
    );
}

#[test]
fn dispute_at_window_end_rejected() {
    let (mut h, job) = purchased();
    h.prove(&job).unwrap();
    h.set_time(h.job(&job).window_ends_at.get());
    assert_eq!(
        custom_error(&h.dispute(&job)),
        Some(WillError::WindowClosed as u32)
    );
}

#[test]
fn dispute_by_non_customer_rejected() {
    let (mut h, job) = purchased();
    h.prove(&job).unwrap();
    for outsider in [copy(&h.operator), copy(&h.stranger)] {
        let instruction = h.dispute_ix(&job, outsider.pubkey());
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotCustomer as u32)
        );
    }
}

#[test]
fn dispute_before_proof_rejected() {
    let (mut h, job) = purchased();
    assert_eq!(
        custom_error(&h.dispute(&job)),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn window_is_fixed_when_proof_is_submitted() {
    // Shortening the configured window afterwards does not cut this job's.
    let (mut h, job) = purchased();
    h.prove(&job).unwrap();
    let ends = h.job(&job).window_ends_at.get();
    h.set_timeouts(60, JOB_TIMEOUT, 60);
    h.set_time(ends - 1);
    h.dispute(&job).unwrap();
    assert_eq!(
        h.job(&job).dispute_expires_at.get(),
        ends - 1 + 60,
        "dispute timeout read when disputing"
    );
}
