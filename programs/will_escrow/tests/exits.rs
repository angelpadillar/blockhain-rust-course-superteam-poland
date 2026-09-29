//! Operator cancel (refund after booking) and the timeout exits: every state
//! has a way out, and none of them pays the caller.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_signer::Signer,
    will_escrow::{error::WillError, state::status::*, Address},
};

const DEPOSIT: u64 = 21 * USDC;

fn setup() -> Harness {
    let mut h = Harness::new();
    h.init_config();
    h
}

/// What the vault is missing in `state` (released or charged funds).
fn outstanding(state: u8) -> u64 {
    match state {
        RELEASED => 15 * USDC,
        PURCHASED | PROVEN | DISPUTED => 13_500_000,
        _ => 0,
    }
}

fn operator_cancel(
    h: &mut Harness,
    job: &Address,
    returned: u64,
    source: Option<Address>,
) -> litesvm::types::TransactionResult {
    let instruction = h.cancel_ix(job, h.operator.pubkey(), h.customer_token, returned, source);
    let operator = copy(&h.operator);
    h.send(instruction, &[&operator])
}

#[test]
fn operator_cancel_from_each_state() {
    for state in [FUNDED, QUOTED, APPROVED, RELEASED, PURCHASED, PROVEN] {
        let mut h = setup();
        let customer_start = h.token_balance(&h.customer_token);
        let job = h.job_in_state(1, state);
        let rent = h.lamports(&job) + h.lamports(&vault_address(&job));
        let operator_tokens = h.token_balance(&h.operator_token);
        let operator_lamports = h.lamports(&h.operator.pubkey());
        let returned = outstanding(state);
        let source = h.operator_token;
        operator_cancel(&mut h, &job, returned, Some(source))
            .unwrap_or_else(|e| panic!("state {state}: {:?}", e.err));
        assert_eq!(
            h.token_balance(&h.customer_token),
            customer_start,
            "state {state}: customer made whole"
        );
        assert_eq!(
            h.token_balance(&h.operator_token),
            operator_tokens - returned
        );
        assert!(h.account(&job).is_none() && h.account(&vault_address(&job)).is_none());
        assert_eq!(
            h.lamports(&h.operator.pubkey()),
            operator_lamports + rent - 5_000,
            "rent back, minus the fee"
        );
    }
}

#[test]
fn operator_cancel_from_released_with_return_refunds_all() {
    let mut h = setup();
    let customer_start = h.token_balance(&h.customer_token);
    let job = h.job_in_state(1, RELEASED);
    assert_eq!(h.token_balance(&vault_address(&job)), DEPOSIT - 15 * USDC);
    let source = h.operator_token;
    operator_cancel(&mut h, &job, 15 * USDC, Some(source)).unwrap();
    assert_eq!(h.token_balance(&h.customer_token), customer_start);
}

#[test]
fn operator_cancel_requires_exact_return() {
    let mut h = setup();
    let job = h.job_in_state(1, PURCHASED);
    let source = h.operator_token;
    for returned in [0, 13_500_000 - 1, 13_500_000 + 1] {
        let result = operator_cancel(&mut h, &job, returned, Some(source));
        assert_eq!(
            custom_error(&result),
            Some(WillError::BadAmount as u32),
            "returned {returned}"
        );
    }
    let result = operator_cancel(&mut h, &job, 13_500_000, None);
    assert!(result.is_err(), "the return needs a source account");
}

#[test]
fn operator_cancel_return_from_foreign_account_rejected() {
    let mut h = setup();
    let job = h.job_in_state(1, RELEASED);
    let source = h.stranger_token;
    let result = operator_cancel(&mut h, &job, 15 * USDC, Some(source));
    assert_eq!(custom_error(&result), Some(WillError::NotOperator as u32));
}

#[test]
fn operator_cancel_in_dispute_rejected() {
    let mut h = setup();
    let job = h.job_in_state(1, DISPUTED);
    let source = h.operator_token;
    let result = operator_cancel(&mut h, &job, 13_500_000, Some(source));
    assert_eq!(custom_error(&result), Some(WillError::BadState as u32));
}

#[test]
fn customer_cancel_cannot_return_funds() {
    let mut h = setup();
    let job = h.job_in_state(1, FUNDED);
    let instruction = h.cancel_ix(
        &job,
        h.customer.pubkey(),
        h.customer_token,
        1,
        Some(h.customer_token),
    );
    let customer = copy(&h.customer);
    assert_eq!(
        custom_error(&h.send(instruction, &[&customer])),
        Some(WillError::BadAmount as u32)
    );
}

/// Advances past the state's deadline and runs its permissionless exit as a
/// stranger. Returns (customer, treasury) token deltas.
fn stranger_exit(h: &mut Harness, job: &Address, state: u8) -> (u64, u64) {
    let (customer_before, treasury_before) = (
        h.token_balance(&h.customer_token),
        h.token_balance(&h.treasury_token),
    );
    let stranger = copy(&h.stranger);
    let state_now = h.job(job);
    match state {
        PROVEN => {
            h.set_time(state_now.window_ends_at.get());
            h.settle(job, &stranger).unwrap();
        }
        DISPUTED => {
            h.set_time(state_now.dispute_expires_at.get());
            let instruction = h.refund_expired_ix(job, h.customer_token, state_now.rent_payer);
            h.send(instruction, &[&stranger]).unwrap();
        }
        _ => {
            h.set_time(state_now.expires_at.get());
            let instruction = h.refund_expired_ix(job, h.customer_token, state_now.rent_payer);
            h.send(instruction, &[&stranger]).unwrap();
        }
    }
    (
        h.token_balance(&h.customer_token) - customer_before,
        h.token_balance(&h.treasury_token) - treasury_before,
    )
}

#[test]
fn no_stuck_funds_every_state_has_stranger_exit() {
    for state in [
        FUNDED, QUOTED, APPROVED, RELEASED, PURCHASED, PROVEN, DISPUTED,
    ] {
        let mut h = setup();
        let job = h.job_in_state(1, state);
        let vault = h.token_balance(&vault_address(&job));
        let (to_customer, to_treasury) = stranger_exit(&mut h, &job, state);
        let fee = if state == PROVEN { 675_000 } else { 0 };
        assert_eq!(
            (to_customer, to_treasury),
            (vault - fee, fee),
            "state {state}"
        );
        assert!(
            h.account(&job).is_none() && h.account(&vault_address(&job)).is_none(),
            "state {state}"
        );
    }
}

#[test]
fn timeout_pays_only_customer_or_earned_fee_never_caller() {
    for state in [
        FUNDED, QUOTED, APPROVED, RELEASED, PURCHASED, PROVEN, DISPUTED,
    ] {
        let mut h = setup();
        let job = h.job_in_state(1, state);
        let vault_tokens = h.token_balance(&vault_address(&job));
        let rent = h.lamports(&job) + h.lamports(&vault_address(&job));
        let rent_payer = h.job(&job).rent_payer;
        let rent_payer_before = h.lamports(&rent_payer);
        let stranger_tokens = h.token_balance(&h.stranger_token);
        let stranger_lamports = h.lamports(&h.stranger.pubkey());

        // The caller cannot redirect any leg of the payout to itself.
        let deadline = match state {
            PROVEN => h.job(&job).window_ends_at.get(),
            DISPUTED => h.job(&job).dispute_expires_at.get(),
            _ => h.job(&job).expires_at.get(),
        };
        h.set_time(deadline);
        let stranger = copy(&h.stranger);
        let hijacks = if state == PROVEN {
            vec![
                h.settle_ix(&job, stranger.pubkey(), h.stranger_token, h.treasury_token),
                h.settle_ix(&job, stranger.pubkey(), h.customer_token, h.stranger_token),
            ]
        } else {
            vec![
                h.refund_expired_ix(&job, h.stranger_token, rent_payer),
                h.refund_expired_ix(&job, h.customer_token, stranger.pubkey()),
            ]
        };
        for hijack in hijacks {
            let result = h.send(hijack, &[&stranger]);
            assert_eq!(
                custom_error(&result),
                Some(WillError::WrongRecipient as u32),
                "state {state}"
            );
        }

        let (to_customer, to_treasury) = stranger_exit(&mut h, &job, state);
        assert_eq!(
            to_customer + to_treasury,
            vault_tokens,
            "state {state}: every token to customer or fee"
        );
        assert_eq!(
            to_treasury,
            if state == PROVEN { 675_000 } else { 0 },
            "state {state}: fee only when earned"
        );
        assert_eq!(
            h.token_balance(&h.stranger_token),
            stranger_tokens,
            "state {state}"
        );
        assert_eq!(
            h.lamports(&h.stranger.pubkey()),
            stranger_lamports - 3 * 5_000,
            "state {state}: only fees"
        );
        assert_eq!(
            h.lamports(&rent_payer),
            rent_payer_before + rent,
            "state {state}: rent to its payer"
        );
    }
}
