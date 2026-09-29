//! Every instruction in every job state: exactly the transitions in the spec
//! table succeed. States are reached through real transitions.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    litesvm::types::TransactionResult,
    solana_signer::Signer,
    will_escrow::{instructions::approve_quote::terms_hash, state::status::*, Address},
};

const STATES: [u8; 7] = [
    FUNDED, QUOTED, APPROVED, RELEASED, PURCHASED, PROVEN, DISPUTED,
];

type Step<'a> = (u8, &'a dyn Fn(&mut Harness) -> TransactionResult);

/// Like `Harness::job_in_state`, but releases 12 of the 15 USDC cap (so a
/// top-up is possible) and records the full 12 as charged.
fn drive(h: &mut Harness, state: u8) -> Address {
    let job = h.create_job(1, 20 * USDC);
    let steps: [Step; 6] = [
        (QUOTED, &|h| h.submit_quote(&job, &quote_args(h.now()))),
        (APPROVED, &|h| h.approve(&job)),
        (RELEASED, &|h| h.release(&job, 12 * USDC)),
        (PURCHASED, &|h| h.record(&job, 12 * USDC)),
        (PROVEN, &|h| h.prove(&job)),
        (DISPUTED, &|h| h.dispute(&job)),
    ];
    for (reached, step) in steps {
        if state >= reached {
            step(h).unwrap();
        }
    }
    assert_eq!(h.job(&job).status, state);
    job
}

fn latest_deadline(h: &Harness, job: &Address) -> i64 {
    let state = h.job(job);
    [
        state.expires_at.get(),
        state.window_ends_at.get(),
        state.dispute_expires_at.get(),
    ]
    .into_iter()
    .max()
    .unwrap()
}

type Row = (
    &'static str,
    &'static [u8],
    fn(&mut Harness, &Address) -> TransactionResult,
);

const ROWS: &[Row] = &[
    ("initialize_config", &[], |h, _| {
        let instruction = h.init_config_ix();
        h.send(instruction, &[&copy(&h.upgrade_authority)])
    }),
    ("update_config", &STATES, |h, _| {
        h.set_paused(false);
        Ok(Default::default())
    }),
    ("create_job_same_id", &[], |h, _| {
        let instruction = h.create_job_ix(
            &job_args(1, USDC),
            h.customer.pubkey(),
            h.customer_token,
            h.operator.pubkey(),
            h.mint,
        );
        let (operator, customer) = (copy(&h.operator), copy(&h.customer));
        h.send(instruction, &[&operator, &customer])
    }),
    ("submit_quote", &[FUNDED, QUOTED], |h, job| {
        h.submit_quote(job, &quote_args(h.now()))
    }),
    ("approve_quote", &[QUOTED], |h, job| {
        let terms = terms_hash(job, &h.job(job));
        let instruction = h.approve_ix(job, h.customer.pubkey(), terms);
        h.send(instruction, &[&copy(&h.customer)])
    }),
    ("release_for_purchase", &[APPROVED, RELEASED], |h, job| {
        h.release(job, USDC)
    }),
    ("record_purchase", &[RELEASED], |h, job| {
        let released = h.job(job).released.get();
        h.record(job, released.max(1))
    }),
    ("submit_proof", &[PURCHASED], |h, job| h.prove(job)),
    ("dispute", &[PROVEN], |h, job| h.dispute(job)),
    ("settle_by_customer", &[PROVEN], |h, job| {
        let customer = copy(&h.customer);
        h.settle(job, &customer)
    }),
    ("resolve_dispute", &[DISPUTED], |h, job| {
        let instruction = h.resolve_ix(job, h.admin.pubkey(), 0);
        h.send(instruction, &[&copy(&h.admin)])
    }),
    ("cancel_by_customer", &[FUNDED, QUOTED], |h, job| {
        let instruction = h.cancel_ix(job, h.customer.pubkey(), h.customer_token, 0, None);
        h.send(instruction, &[&copy(&h.customer)])
    }),
    (
        "cancel_by_operator",
        &[FUNDED, QUOTED, APPROVED, RELEASED, PURCHASED, PROVEN],
        |h, job| {
            let missing = 21 * USDC - h.token_balance(&vault_address(job));
            let instruction = h.cancel_ix(
                job,
                h.operator.pubkey(),
                h.customer_token,
                missing,
                Some(h.operator_token),
            );
            h.send(instruction, &[&copy(&h.operator)])
        },
    ),
    ("refund_expired_now", &[], |h, job| {
        let instruction = h.refund_expired_ix(job, h.customer_token, h.job(job).rent_payer);
        h.send(instruction, &[&copy(&h.stranger)])
    }),
    (
        "refund_expired_late",
        &[FUNDED, QUOTED, APPROVED, RELEASED, PURCHASED, DISPUTED],
        |h, job| {
            h.set_time(latest_deadline(h, job));
            let instruction = h.refund_expired_ix(job, h.customer_token, h.job(job).rent_payer);
            h.send(instruction, &[&copy(&h.stranger)])
        },
    ),
    ("settle_by_stranger_late", &[PROVEN], |h, job| {
        h.set_time(latest_deadline(h, job));
        let stranger = copy(&h.stranger);
        h.settle(job, &stranger)
    }),
];

#[test]
fn only_spec_transitions_succeed() {
    let mut mismatches = Vec::new();
    for (name, allowed, run) in ROWS {
        for state in STATES {
            let mut h = Harness::new();
            h.init_config();
            let job = drive(&mut h, state);
            let result = run(&mut h, &job);
            if result.is_ok() != allowed.contains(&state) {
                mismatches.push(format!(
                    "{name} in state {state}: {:?}",
                    result.map(|_| ()).map_err(|e| e.err)
                ));
            }
        }
    }
    assert!(
        mismatches.is_empty(),
        "unexpected outcomes:\n{}",
        mismatches.join("\n")
    );
}
