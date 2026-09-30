//! Account-level checks Pinocchio does not do for us: signature flags,
//! writability, program ids, canonical PDAs, vault binding, type tags,
//! arithmetic bounds, and which paths a pause blocks.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_signer::Signer,
    will_escrow::{error::WillError, instructions::approve_quote::terms_hash, state::status},
};

fn setup() -> Harness {
    let mut h = Harness::new();
    h.init_config();
    h
}

fn builtin(result: &litesvm::types::TransactionResult) -> String {
    format!("{:?}", result.as_ref().err().map(|e| &e.err))
}

#[test]
fn missing_signature_rejected() {
    // The right key, but not signing: approval must fail.
    let mut h = setup();
    let job = h.create_job(1, 20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    let mut instruction = h.approve_ix(&job, h.customer.pubkey(), terms_hash(&job, &h.job(&job)));
    instruction.accounts[1].is_signer = false;
    let operator = copy(&h.operator);
    let result = h.send(instruction, &[&operator]);
    assert!(
        builtin(&result).contains("MissingRequiredSignature"),
        "{}",
        builtin(&result)
    );
    assert_eq!(h.job(&job).status, status::QUOTED);
}

#[test]
fn job_must_be_writable() {
    let mut h = setup();
    let job = h.create_job(1, 20 * USDC);
    let mut instruction = h.submit_quote_ix(&job, h.operator.pubkey(), &quote_args(h.now()));
    instruction.accounts[1].is_writable = false;
    let operator = copy(&h.operator);
    let result = h.send(instruction, &[&operator]);
    assert!(
        builtin(&result).contains("Immutable"),
        "{}",
        builtin(&result)
    );
}

#[test]
fn wrong_token_program_rejected() {
    let mut h = setup();
    let job = h.job_in_state(1, status::PROVEN);
    let customer = copy(&h.customer);
    let mut instruction = h.settle_ix(&job, customer.pubkey(), h.customer_token, h.treasury_token);
    instruction.accounts[7].pubkey = SYSTEM_PROGRAM;
    let result = h.send(instruction, &[&customer]);
    assert!(
        builtin(&result).contains("IncorrectProgramId"),
        "{}",
        builtin(&result)
    );
    assert!(h.account(&job).is_some());
}

#[test]
fn wrong_system_program_rejected() {
    let mut h = setup();
    let mut instruction = h.create_job_ix(
        &job_args(1, USDC),
        h.customer.pubkey(),
        h.customer_token,
        h.operator.pubkey(),
        h.mint,
    );
    instruction.accounts[8].pubkey = TOKEN_PROGRAM;
    let (operator, customer) = (copy(&h.operator), copy(&h.customer));
    let result = h.send(instruction, &[&operator, &customer]);
    assert!(
        builtin(&result).contains("IncorrectProgramId"),
        "{}",
        builtin(&result)
    );
}

#[test]
fn create_job_at_non_canonical_address_rejected() {
    // Job 1's instruction pointed at job 2's address: not the PDA of its seeds.
    let mut h = setup();
    let mut instruction = h.create_job_ix(
        &job_args(1, USDC),
        h.customer.pubkey(),
        h.customer_token,
        h.operator.pubkey(),
        h.mint,
    );
    let other = job_address(&h.customer.pubkey(), 2);
    instruction.accounts[1].pubkey = other;
    instruction.accounts[2].pubkey = vault_address(&other);
    let (operator, customer) = (copy(&h.operator), copy(&h.customer));
    let result = h.send(instruction, &[&operator, &customer]);
    assert!(
        builtin(&result).contains("InvalidSeeds"),
        "{}",
        builtin(&result)
    );
}

#[test]
fn vault_of_other_job_rejected() {
    let mut h = setup();
    let job = h.job_in_state(1, status::PROVEN);
    let other = h.create_job(2, 20 * USDC);
    let customer = copy(&h.customer);
    let mut instruction = h.settle_ix(&job, customer.pubkey(), h.customer_token, h.treasury_token);
    instruction.accounts[2].pubkey = vault_address(&other);
    let result = h.send(instruction, &[&customer]);
    assert!(
        builtin(&result).contains("InvalidSeeds"),
        "{}",
        builtin(&result)
    );
    assert_eq!(h.token_balance(&vault_address(&other)), 21 * USDC);
}

#[test]
fn config_account_cannot_be_used_as_job() {
    // The config (275 bytes) is rejected by the size check before its tag is
    // read; `state::tests::load_rejects_wrong_tag` covers a same-size forgery.
    let mut h = setup();
    let instruction =
        h.submit_quote_ix(&config_address(), h.operator.pubkey(), &quote_args(h.now()));
    let operator = copy(&h.operator);
    let result = h.send(instruction, &[&operator]);
    assert!(
        builtin(&result).contains("AccountDataTooSmall"),
        "{}",
        builtin(&result)
    );
}

#[test]
fn create_job_rejects_overflowing_budget() {
    let mut h = setup();
    let instruction = h.create_job_ix(
        &job_args(1, u64::MAX),
        h.customer.pubkey(),
        h.customer_token,
        h.operator.pubkey(),
        h.mint,
    );
    let (operator, customer) = (copy(&h.operator), copy(&h.customer));
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator, &customer])),
        Some(WillError::Overflow as u32)
    );
}

#[test]
fn exits_work_while_paused() {
    // Pausing blocks new jobs and releases, never a way out.
    let mut h = setup();
    let proven = h.job_in_state(1, status::PROVEN);
    let released = h.job_in_state(2, status::RELEASED);
    let funded = h.job_in_state(3, status::FUNDED);
    h.set_paused(true);
    let customer = copy(&h.customer);
    h.settle(&proven, &customer).unwrap();
    let returned = 15 * USDC;
    let instruction = h.cancel_ix(
        &released,
        h.operator.pubkey(),
        h.customer_token,
        returned,
        Some(h.operator_token),
    );
    h.send(instruction, &[&copy(&h.operator)]).unwrap();
    h.set_time(h.job(&funded).expires_at.get());
    let instruction = h.refund_expired_ix(&funded, h.customer_token, h.job(&funded).rent_payer);
    h.send(instruction, &[&copy(&h.stranger)]).unwrap();
    assert!([proven, released, funded]
        .iter()
        .all(|job| h.account(job).is_none()));
}
