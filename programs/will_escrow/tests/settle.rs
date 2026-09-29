//! settle, resolve_dispute and account closing.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
    will_escrow::{error::WillError, state::status, Address},
};

/// Charged 13.5 USDC at 5%: fee 0.675, refund 7.5 - 0.675 = 6.825 USDC.
const FEE: u64 = 675_000;
const REFUND: u64 = 6_825_000;

fn proven() -> (Harness, Address) {
    let mut h = Harness::new();
    h.init_config();
    let job = h.proven_job(1);
    (h, job)
}

fn assert_settled(h: &Harness, job: &Address, customer_before: u64, treasury_before: u64) {
    assert_eq!(h.token_balance(&h.customer_token), customer_before + REFUND);
    assert_eq!(h.token_balance(&h.treasury_token), treasury_before + FEE);
    assert!(h.account(job).is_none() && h.account(&vault_address(job)).is_none());
}

#[test]
fn settle_early_by_customer() {
    let (mut h, job) = proven();
    let (customer_before, treasury_before) = (
        h.token_balance(&h.customer_token),
        h.token_balance(&h.treasury_token),
    );
    let customer = copy(&h.customer);
    let operator = copy(&h.operator);
    let instruction = h.settle_ix(&job, customer.pubkey(), h.customer_token, h.treasury_token);
    h.send(instruction, &[&operator, &customer]).unwrap();
    assert_settled(&h, &job, customer_before, treasury_before);
}

#[test]
fn settle_by_stranger_during_window_rejected() {
    let (mut h, job) = proven();
    h.set_time(h.job(&job).window_ends_at.get() - 1);
    for caller in [copy(&h.stranger), copy(&h.operator)] {
        assert_eq!(
            custom_error(&h.settle(&job, &caller)),
            Some(WillError::WindowOpen as u32)
        );
    }
}

#[test]
fn settle_at_window_end_allowed() {
    let (mut h, job) = proven();
    let (customer_before, treasury_before) = (
        h.token_balance(&h.customer_token),
        h.token_balance(&h.treasury_token),
    );
    h.set_time(h.job(&job).window_ends_at.get());
    let stranger = copy(&h.stranger);
    h.settle(&job, &stranger).unwrap();
    assert_settled(&h, &job, customer_before, treasury_before);
}

#[test]
fn settle_by_stranger_after_window() {
    let (mut h, job) = proven();
    let stranger_tokens = h.token_balance(&h.stranger_token);
    let stranger_before = h.lamports(&h.stranger.pubkey());
    h.set_time(h.job(&job).window_ends_at.get() + 3_600);
    let stranger = copy(&h.stranger);
    h.settle(&job, &stranger).unwrap();
    assert_eq!(h.token_balance(&h.stranger_token), stranger_tokens);
    assert_eq!(
        h.lamports(&h.stranger.pubkey()),
        stranger_before - 5_000,
        "only the fee"
    );
}

#[test]
fn settle_refund_to_any_customer_owned_usdc_account() {
    let (mut h, job) = proven();
    let second = h.create_token_account(h.mint, h.customer.pubkey());
    let customer = copy(&h.customer);
    let operator = copy(&h.operator);
    let instruction = h.settle_ix(&job, customer.pubkey(), second, h.treasury_token);
    h.send(instruction, &[&operator, &customer]).unwrap();
    assert_eq!(h.token_balance(&second), REFUND);
}

#[test]
fn settle_refund_to_foreign_account_rejected() {
    let (mut h, job) = proven();
    let customer = copy(&h.customer);
    let operator = copy(&h.operator);
    let instruction = h.settle_ix(&job, customer.pubkey(), h.stranger_token, h.treasury_token);
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator, &customer])),
        Some(WillError::WrongRecipient as u32)
    );
    let instruction = h.settle_ix(&job, customer.pubkey(), h.customer_token, h.stranger_token);
    assert_eq!(
        custom_error(&h.send(instruction, &[&operator, &customer])),
        Some(WillError::WrongRecipient as u32)
    );
    assert_eq!(h.job(&job).status, status::PROVEN);
}

#[test]
fn rent_returns_to_rent_payer() {
    let (mut h, job) = proven();
    let rent = h.lamports(&job) + h.lamports(&vault_address(&job));
    let operator_before = h.lamports(&h.operator.pubkey());
    h.set_time(h.job(&job).window_ends_at.get());
    let stranger = copy(&h.stranger);
    h.settle(&job, &stranger).unwrap();
    assert_eq!(h.lamports(&h.operator.pubkey()), operator_before + rent);
}

#[test]
fn settle_before_proof_rejected() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.purchased_job(1);
    let customer = copy(&h.customer);
    assert_eq!(
        custom_error(&h.settle(&job, &customer)),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn settle_uses_fee_rate_fixed_at_creation() {
    let (mut h, job) = proven();
    let mut config = h.config();
    config.fee_bps.set(1_000);
    h.update_config(will_escrow::instructions::update_config::UpdateConfig {
        fee_bps: config.fee_bps,
        dispute_window: config.dispute_window,
        job_timeout: config.job_timeout,
        dispute_timeout: config.dispute_timeout,
        paused: config.paused,
        new_admin: config.admin,
        operator: config.operator,
        treasury: config.treasury,
    });
    let treasury_before = h.token_balance(&h.treasury_token);
    let customer = copy(&h.customer);
    h.settle(&job, &customer).unwrap();
    assert_eq!(h.token_balance(&h.treasury_token), treasury_before + FEE);
}

#[test]
fn closed_job_cannot_be_revived_in_same_tx() {
    let (mut h, job) = proven();
    let customer = copy(&h.customer);
    let settle = h.settle_ix(&job, customer.pubkey(), h.customer_token, h.treasury_token);
    let refill =
        solana_system_interface::instruction::transfer(&customer.pubkey(), &job, 10_000_000);
    h.svm.airdrop(&customer.pubkey(), 1_000_000_000).unwrap();
    h.send_many(&[settle, refill], &[&customer]).unwrap();
    let revived = h.svm.get_account(&job).unwrap();
    assert_eq!(
        revived.owner, SYSTEM_PROGRAM,
        "reassigned to the system program"
    );
    assert!(revived.data.is_empty(), "no job data left");
    // The program no longer treats it as a job.
    let quote = h.submit_quote_ix(&job, h.operator.pubkey(), &quote_args(h.now()));
    let operator = copy(&h.operator);
    assert!(h.send(quote, &[&operator]).is_err());
}

#[test]
fn recreate_after_close_is_fresh() {
    let (mut h, job) = proven();
    let customer = copy(&h.customer);
    h.settle(&job, &customer).unwrap();
    let again = h.create_job(1, 5 * USDC);
    assert_eq!(again, job, "same job id, same address");
    let state = h.job(&again);
    assert_eq!(state.status, status::FUNDED);
    assert_eq!(
        (
            state.budget.get(),
            state.charged.get(),
            state.released.get()
        ),
        (5 * USDC, 0, 0)
    );
    assert_eq!((state.quote_hash, state.proof_hash), ([0; 32], [0; 32]));
}

fn disputed() -> (Harness, Address) {
    let (mut h, job) = proven();
    h.dispute(&job).unwrap();
    (h, job)
}

#[test]
fn resolve_dispute_admin_only() {
    let (mut h, job) = disputed();
    for outsider in [
        copy(&h.stranger),
        copy(&h.operator),
        copy(&h.customer),
        copy(&h.upgrade_authority),
    ] {
        let instruction = h.resolve_ix(&job, outsider.pubkey(), 0);
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotAdmin as u32)
        );
    }
    let admin = copy(&h.admin);
    let instruction = h.resolve_ix(&job, admin.pubkey(), 0);
    h.send(instruction, &[&admin]).unwrap();
    assert!(h.account(&job).is_none());
}

#[test]
fn resolve_dispute_split_bounds() {
    let (mut h, job) = disputed();
    let admin = copy(&h.admin);
    let instruction = h.resolve_ix(&job, admin.pubkey(), FEE + 1);
    assert_eq!(
        custom_error(&h.send(instruction, &[&admin])),
        Some(WillError::CapExceeded as u32)
    );
    let (customer_before, treasury_before) = (
        h.token_balance(&h.customer_token),
        h.token_balance(&h.treasury_token),
    );
    let instruction = h.resolve_ix(&job, admin.pubkey(), 200_000);
    h.send(instruction, &[&admin]).unwrap();
    assert_eq!(
        h.token_balance(&h.treasury_token),
        treasury_before + 200_000
    );
    assert_eq!(
        h.token_balance(&h.customer_token),
        customer_before + 7_500_000 - 200_000
    );
}

#[test]
fn resolve_requires_dispute() {
    let (mut h, job) = proven();
    let admin = copy(&h.admin);
    let instruction = h.resolve_ix(&job, admin.pubkey(), 0);
    assert_eq!(
        custom_error(&h.send(instruction, &[&admin])),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn disputed_job_cannot_be_settled() {
    let (mut h, job) = disputed();
    h.set_time(h.job(&job).window_ends_at.get() + 1);
    let customer: Keypair = copy(&h.customer);
    assert_eq!(
        custom_error(&h.settle(&job, &customer)),
        Some(WillError::BadState as u32)
    );
}
