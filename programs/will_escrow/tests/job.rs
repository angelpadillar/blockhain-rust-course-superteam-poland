//! create_job, customer cancel before approval, and the timeout refund.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
    will_escrow::{
        error::WillError,
        state::{status, JOB_TAG},
    },
};

fn setup() -> Harness {
    let mut h = Harness::new();
    h.init_config();
    h
}

fn send_create(
    h: &mut Harness,
    args: &will_escrow::instructions::create_job::CreateJob,
) -> litesvm::types::TransactionResult {
    let instruction = h.create_job_ix(
        args,
        h.customer.pubkey(),
        h.customer_token,
        h.operator.pubkey(),
        h.mint,
    );
    let (operator, customer) = (copy(&h.operator), copy(&h.customer));
    h.send(instruction, &[&operator, &customer])
}

fn cancel_by(
    h: &mut Harness,
    job: &will_escrow::Address,
    signer: &Keypair,
) -> litesvm::types::TransactionResult {
    let instruction = h.cancel_ix(job, signer.pubkey(), h.customer_token, 0, None);
    let signer = copy(signer);
    h.send(instruction, &[&signer])
}

fn refund_by_stranger(
    h: &mut Harness,
    job: &will_escrow::Address,
) -> litesvm::types::TransactionResult {
    let rent_payer = h.job(job).rent_payer;
    let instruction = h.refund_expired_ix(job, h.customer_token, rent_payer);
    let stranger = copy(&h.stranger);
    h.send(instruction, &[&stranger])
}

#[test]
fn create_job_funds_vault_exactly() {
    let mut h = setup();
    let before = h.token_balance(&h.customer_token);
    let job = h.create_job(1, 60 * USDC);
    assert_eq!(h.token_balance(&vault_address(&job)), 63 * USDC);
    assert_eq!(h.token_balance(&h.customer_token), before - 63 * USDC);
    let state = h.job(&job);
    assert_eq!((state.tag, state.status), (JOB_TAG, status::FUNDED));
    assert_eq!(
        (
            state.budget.get(),
            state.fee_reserve.get(),
            state.fee_bps.get()
        ),
        (60 * USDC, 3 * USDC, FEE_BPS)
    );
    assert_eq!(
        (state.customer, state.rent_payer),
        (h.customer.pubkey(), h.operator.pubkey())
    );
    assert_eq!(
        (state.job_id.get(), state.job_kind, state.adapter),
        (1, 0, 1)
    );
    assert_eq!(state.expires_at.get(), START + i64::from(JOB_TIMEOUT));
}

#[test]
fn fee_reserve_rounds_up() {
    let mut h = setup();
    let job = h.create_job(1, 1);
    assert_eq!(h.job(&job).fee_reserve.get(), 1);
    assert_eq!(h.token_balance(&vault_address(&job)), 2);
}

#[test]
fn create_job_rejects_kind_16() {
    let mut h = setup();
    for (kind, adapter) in [(16, 0), (0, 16), (255, 255)] {
        let mut args = job_args(1, USDC);
        (args.job_kind, args.adapter) = (kind, adapter);
        assert_eq!(
            custom_error(&send_create(&mut h, &args)),
            Some(WillError::KindOutOfRange as u32)
        );
    }
    let mut args = job_args(1, USDC);
    (args.job_kind, args.adapter) = (15, 15);
    send_create(&mut h, &args).unwrap();
}

#[test]
fn create_job_rejects_zero_budget() {
    let mut h = setup();
    assert_eq!(
        custom_error(&send_create(&mut h, &job_args(1, 0))),
        Some(WillError::BadAmount as u32)
    );
}

#[test]
fn create_job_rejects_mandate_expiring_after_job() {
    let mut h = setup();
    let mut args = job_args(1, USDC);
    args.mandate_cap.set(USDC);
    args.mandate_expires_at
        .set(START + i64::from(JOB_TIMEOUT) + 1);
    assert_eq!(
        custom_error(&send_create(&mut h, &args)),
        Some(WillError::BadAmount as u32)
    );
    args.mandate_expires_at.set(START + i64::from(JOB_TIMEOUT));
    send_create(&mut h, &args).unwrap();
}

#[test]
fn create_job_rejects_wrong_mint() {
    let mut h = setup();
    let other_customer_token = h.create_token_account(h.other_mint, h.customer.pubkey());
    let args = job_args(1, USDC);
    let (operator, customer) = (copy(&h.operator), copy(&h.customer));
    // Customer token account of another mint.
    let instruction = h.create_job_ix(
        &args,
        customer.pubkey(),
        other_customer_token,
        operator.pubkey(),
        h.mint,
    );
    assert!(h.send(instruction, &[&operator, &customer]).is_err());
    // Another mint account.
    let instruction = h.create_job_ix(
        &args,
        customer.pubkey(),
        h.customer_token,
        operator.pubkey(),
        h.other_mint,
    );
    assert!(h.send(instruction, &[&operator, &customer]).is_err());
    assert!(h.account(&job_address(&customer.pubkey(), 1)).is_none());
}

#[test]
fn create_job_prefunded_pda_ok() {
    let mut h = setup();
    let job = job_address(&h.customer.pubkey(), 1);
    let stranger = copy(&h.stranger);
    for (target, lamports) in [(job, 1), (vault_address(&job), 10_000_000)] {
        let transfer =
            solana_system_interface::instruction::transfer(&stranger.pubkey(), &target, lamports);
        h.send(transfer, &[&stranger]).unwrap();
    }
    let job = h.create_job(1, 10 * USDC);
    assert_eq!(h.job(&job).status, status::FUNDED);
    assert_eq!(h.token_balance(&vault_address(&job)), 10 * USDC + USDC / 2);
}

#[test]
fn create_job_twice_rejected() {
    let mut h = setup();
    let job = h.create_job(1, USDC);
    let before = h.account(&job).unwrap();
    assert!(send_create(&mut h, &job_args(1, 5 * USDC)).is_err());
    assert_eq!(h.account(&job).unwrap(), before);
}

#[test]
fn customer_needs_no_sol() {
    let mut h = setup();
    let customer = Keypair::new();
    let customer_token = h.create_token_account(h.mint, customer.pubkey());
    h.mint_to(customer_token, 10 * USDC);
    let instruction = h.create_job_ix(
        &job_args(1, USDC),
        customer.pubkey(),
        customer_token,
        h.operator.pubkey(),
        h.mint,
    );
    let operator = copy(&h.operator);
    h.send(instruction, &[&operator, &customer]).unwrap();
    assert_eq!(h.lamports(&customer.pubkey()), 0);
}

#[test]
fn create_job_when_paused_rejected() {
    let mut h = setup();
    pause(&mut h);
    assert_eq!(
        custom_error(&send_create(&mut h, &job_args(1, USDC))),
        Some(WillError::Paused as u32)
    );
}

#[test]
fn customer_cancel_before_approval_full_refund_and_close() {
    for state in [status::FUNDED, status::QUOTED] {
        let mut h = setup();
        let before = h.token_balance(&h.customer_token);
        let operator_before = h.lamports(&h.operator.pubkey());
        let job = h.create_job(1, 60 * USDC);
        let rent = h.lamports(&job) + h.lamports(&vault_address(&job));
        let operator_after_create = h.lamports(&h.operator.pubkey());
        h.set_job(&job, |j| j.status = state);
        let customer = copy(&h.customer);
        cancel_by(&mut h, &job, &customer).unwrap();
        assert_eq!(h.token_balance(&h.customer_token), before);
        assert!(h.account(&job).is_none() && h.account(&vault_address(&job)).is_none());
        assert_eq!(
            h.lamports(&h.operator.pubkey()),
            operator_after_create + rent,
            "rent back to the payer"
        );
        assert!(operator_before > operator_after_create);
    }
}

#[test]
fn customer_cancel_after_approval_rejected() {
    for state in [
        status::APPROVED,
        status::RELEASED,
        status::PURCHASED,
        status::PROVEN,
        status::DISPUTED,
    ] {
        let mut h = setup();
        let job = h.create_job(1, USDC);
        h.set_job(&job, |j| j.status = state);
        let customer = copy(&h.customer);
        assert_eq!(
            custom_error(&cancel_by(&mut h, &job, &customer)),
            Some(WillError::BadState as u32),
            "state {state}"
        );
        assert!(h.account(&job).is_some());
    }
}

#[test]
fn cancel_by_stranger_rejected() {
    let mut h = setup();
    let job = h.create_job(1, USDC);
    let stranger = copy(&h.stranger);
    assert_eq!(
        custom_error(&cancel_by(&mut h, &job, &stranger)),
        Some(WillError::NotCustomer as u32)
    );
}

#[test]
fn refund_expired_by_stranger_after_timeout() {
    let mut h = setup();
    let before = h.token_balance(&h.customer_token);
    let stranger_tokens = h.token_balance(&h.stranger_token);
    let job = h.create_job(1, 60 * USDC);
    let rent = h.lamports(&job) + h.lamports(&vault_address(&job));
    let operator_before = h.lamports(&h.operator.pubkey());
    let stranger_before = h.lamports(&h.stranger.pubkey());
    h.set_time(h.job(&job).expires_at.get());
    refund_by_stranger(&mut h, &job).unwrap();
    assert_eq!(h.token_balance(&h.customer_token), before);
    assert!(h.account(&job).is_none() && h.account(&vault_address(&job)).is_none());
    assert_eq!(h.lamports(&h.operator.pubkey()), operator_before + rent);
    assert_eq!(h.token_balance(&h.stranger_token), stranger_tokens);
    assert_eq!(
        h.lamports(&h.stranger.pubkey()),
        stranger_before - 5_000,
        "only the fee"
    );
}

#[test]
fn refund_expired_before_timeout_rejected() {
    let mut h = setup();
    let job = h.create_job(1, USDC);
    h.set_time(h.job(&job).expires_at.get() - 1);
    assert_eq!(
        custom_error(&refund_by_stranger(&mut h, &job)),
        Some(WillError::NotExpired as u32)
    );
}

#[test]
fn refund_expired_per_state() {
    for state in [
        status::QUOTED,
        status::APPROVED,
        status::RELEASED,
        status::PURCHASED,
    ] {
        let mut h = setup();
        let job = h.create_job(1, USDC);
        h.set_job(&job, |j| j.status = state);
        h.set_time(h.job(&job).expires_at.get());
        refund_by_stranger(&mut h, &job).unwrap_or_else(|e| panic!("state {state}: {:?}", e.err));
    }
    // A proven job settles instead; its window already guarantees an exit.
    let mut h = setup();
    let job = h.create_job(1, USDC);
    h.set_job(&job, |j| j.status = status::PROVEN);
    h.set_time(h.job(&job).expires_at.get() + 1);
    assert_eq!(
        custom_error(&refund_by_stranger(&mut h, &job)),
        Some(WillError::BadState as u32)
    );
    // A dispute waits until the deadline stored when it was opened.
    let mut h = setup();
    let job = h.create_job(1, USDC);
    let dispute_expires_at = START + 100 + i64::from(DISPUTE_TIMEOUT);
    h.set_job(&job, |j| {
        j.status = status::DISPUTED;
        j.dispute_expires_at.set(dispute_expires_at);
    });
    h.set_time(dispute_expires_at - 1);
    assert_eq!(
        custom_error(&refund_by_stranger(&mut h, &job)),
        Some(WillError::NotExpired as u32)
    );
    h.set_time(dispute_expires_at);
    refund_by_stranger(&mut h, &job).unwrap();
}

#[test]
fn refund_goes_only_to_customer_owned_account() {
    let mut h = setup();
    let job = h.create_job(1, USDC);
    h.set_time(h.job(&job).expires_at.get());
    let rent_payer = h.job(&job).rent_payer;
    let instruction = h.refund_expired_ix(&job, h.stranger_token, rent_payer);
    let stranger = copy(&h.stranger);
    assert_eq!(
        custom_error(&h.send(instruction, &[&stranger])),
        Some(WillError::WrongRecipient as u32)
    );
    let instruction = h.refund_expired_ix(&job, h.customer_token, h.stranger.pubkey());
    assert_eq!(
        custom_error(&h.send(instruction, &[&stranger])),
        Some(WillError::WrongRecipient as u32)
    );
    assert!(h.account(&job).is_some());
}

fn pause(h: &mut Harness) {
    use will_escrow::instructions::update_config::{self, UpdateConfig};
    let config = h.config();
    let args = UpdateConfig {
        fee_bps: config.fee_bps,
        dispute_window: config.dispute_window,
        job_timeout: config.job_timeout,
        dispute_timeout: config.dispute_timeout,
        paused: 1,
        admin: config.admin,
        operator: config.operator,
        treasury: config.treasury,
    };
    let instruction = solana_instruction::Instruction {
        program_id: will_escrow::ID,
        accounts: vec![
            meta(config_address(), true, false),
            meta(h.admin.pubkey(), false, true),
            meta(h.funding, false, false),
        ],
        data: data(update_config::DISCRIMINATOR, &args),
    };
    let admin = copy(&h.admin);
    h.send(instruction, &[&admin]).unwrap();
}
