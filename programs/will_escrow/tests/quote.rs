//! submit_quote, approve_quote and the mandate.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    sha2::{Digest, Sha256},
    solana_signer::Signer,
    will_escrow::{
        error::WillError,
        instructions::approve_quote::terms_hash,
        state::{status, Job, Quote},
        Address, ID,
    },
};

fn funded(budget: u64) -> (Harness, Address) {
    let mut h = Harness::new();
    h.init_config();
    let job = h.create_job(1, budget);
    (h, job)
}

fn funded_with_mandate(cap: u64, expires_at: i64) -> (Harness, Address) {
    let mut h = Harness::new();
    h.init_config();
    let mut args = job_args(1, 20 * USDC);
    args.mandate_cap.set(cap);
    args.mandate_expires_at.set(expires_at);
    let instruction = h.create_job_ix(
        &args,
        h.customer.pubkey(),
        h.customer_token,
        h.operator.pubkey(),
        h.mint,
    );
    let (operator, customer) = (copy(&h.operator), copy(&h.customer));
    h.send(instruction, &[&operator, &customer]).unwrap();
    (h, job_address(&customer.pubkey(), 1))
}

#[test]
fn submit_quote_stores_terms() {
    let (mut h, job) = funded(20 * USDC);
    let args = quote_args(h.now());
    h.submit_quote(&job, &args).unwrap();
    let state = h.job(&job);
    assert_eq!(state.status, status::QUOTED);
    assert_eq!((state.quote_currency, state.quote_exponent), (*b"PLN", 2));
    assert_eq!(state.quote, args.quote);
    assert_eq!(
        (state.release_cap.get(), state.quote_hash),
        (15 * USDC, [7; 32])
    );
    assert_eq!(state.quote_expires_at.get(), h.now() + 1_800);
}

#[test]
fn submit_quote_by_non_operator_rejected() {
    let (mut h, job) = funded(20 * USDC);
    let args = quote_args(h.now());
    for outsider in [copy(&h.customer), copy(&h.stranger), copy(&h.admin)] {
        let instruction = h.submit_quote_ix(&job, outsider.pubkey(), &args);
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotOperator as u32)
        );
    }
}

#[test]
fn quote_sum_mismatch_rejected() {
    let (mut h, job) = funded(20 * USDC);
    for total in [5_397, 5_399] {
        let mut args = quote_args(h.now());
        args.total.set(total);
        assert_eq!(
            custom_error(&h.submit_quote(&job, &args)),
            Some(WillError::BadAmount as u32),
            "total {total}"
        );
    }
    let mut args = quote_args(h.now());
    args.quote.tip.set(u64::MAX);
    args.total.set(u64::MAX);
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::Overflow as u32)
    );
}

#[test]
fn quote_over_ceiling_rejected() {
    let (mut h, job) = funded(20 * USDC);
    let mut args = quote_args(h.now());
    args.quote.ceiling.set(5_397);
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::CapExceeded as u32)
    );
    args.quote.ceiling.set(5_398);
    h.submit_quote(&job, &args).unwrap();
}

#[test]
fn release_cap_over_budget_rejected() {
    let (mut h, job) = funded(15 * USDC);
    let mut args = quote_args(h.now());
    args.release_cap.set(15 * USDC + 1);
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::CapExceeded as u32)
    );
    args.release_cap.set(0);
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::BadAmount as u32)
    );
    args.release_cap.set(15 * USDC);
    h.submit_quote(&job, &args).unwrap();
}

#[test]
fn quote_expiry_must_be_future_and_within_job() {
    let (mut h, job) = funded(20 * USDC);
    let mut args = quote_args(h.now());
    args.quote_expires_at.set(h.now());
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::QuoteExpired as u32)
    );
    args.quote_expires_at.set(h.job(&job).expires_at.get() + 1);
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::QuoteExpired as u32)
    );
}

#[test]
fn quote_rejects_bad_currency_and_zero_hash() {
    let (mut h, job) = funded(20 * USDC);
    let mut args = quote_args(h.now());
    args.quote_currency = *b"pln";
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::BadAmount as u32)
    );
    let mut args = quote_args(h.now());
    args.quote_exponent = 5;
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::BadAmount as u32)
    );
    let mut args = quote_args(h.now());
    args.quote_hash = [0; 32];
    assert_eq!(
        custom_error(&h.submit_quote(&job, &args)),
        Some(WillError::BadAmount as u32)
    );
}

#[test]
fn requote_before_approval_ok() {
    let (mut h, job) = funded(20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    let mut second = quote_args(h.now());
    second.quote.item.set(4_000);
    second.total.set(4_898);
    second.quote_hash = [8; 32];
    h.submit_quote(&job, &second).unwrap();
    let state = h.job(&job);
    assert_eq!(
        (state.status, state.quote.item.get(), state.quote_hash),
        (status::QUOTED, 4_000, [8; 32])
    );
}

#[test]
fn quote_after_approval_rejected() {
    let (mut h, job) = funded(20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    h.approve(&job).unwrap();
    assert_eq!(
        custom_error(&h.submit_quote(&job, &quote_args(h.now()))),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn approve_moves_to_approved() {
    let (mut h, job) = funded(20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    h.approve(&job).unwrap();
    assert_eq!(h.job(&job).status, status::APPROVED);
    assert_eq!(
        h.job(&job).flags & 1,
        0,
        "approved by the customer, not the mandate"
    );
}

#[test]
fn approve_requires_customer() {
    let (mut h, job) = funded(20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    let terms = terms_hash(&job, &h.job(&job));
    for outsider in [copy(&h.operator), copy(&h.stranger)] {
        let instruction = h.approve_ix(&job, outsider.pubkey(), terms);
        assert_eq!(
            custom_error(&h.send(instruction, &[&outsider])),
            Some(WillError::NotCustomer as u32)
        );
    }
}

#[test]
fn approve_rejects_wrong_terms_hash() {
    // A signature over an earlier quote cannot approve its replacement.
    let (mut h, job) = funded(20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    let stale = terms_hash(&job, &h.job(&job));
    let mut second = quote_args(h.now());
    second.release_cap.set(20 * USDC);
    h.submit_quote(&job, &second).unwrap();
    let instruction = h.approve_ix(&job, h.customer.pubkey(), stale);
    let customer = copy(&h.customer);
    assert_eq!(
        custom_error(&h.send(instruction, &[&customer])),
        Some(WillError::TermsMismatch as u32)
    );
    assert_eq!(h.job(&job).status, status::QUOTED);
}

#[test]
fn approve_rejects_expired_quote() {
    let (mut h, job) = funded(20 * USDC);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    h.set_time(h.job(&job).quote_expires_at.get());
    assert_eq!(
        custom_error(&h.approve(&job)),
        Some(WillError::QuoteExpired as u32)
    );
    h.set_time(h.job(&job).quote_expires_at.get() - 1);
    h.approve(&job).unwrap();
}

#[test]
fn approve_before_quote_rejected() {
    let (mut h, job) = funded(20 * USDC);
    assert_eq!(
        custom_error(&h.approve(&job)),
        Some(WillError::BadState as u32)
    );
}

#[test]
fn mandate_auto_approves_within_cap() {
    let (mut h, job) = funded_with_mandate(15 * USDC, START + 3_600);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    let state = h.job(&job);
    assert_eq!(state.status, status::APPROVED);
    assert_eq!(state.flags & 1, 1, "approved by the mandate");
}

#[test]
fn mandate_ignored_over_cap_or_expired() {
    let (mut h, job) = funded_with_mandate(15 * USDC - 1, START + 3_600);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    assert_eq!(
        h.job(&job).status,
        status::QUOTED,
        "cap below the release cap"
    );

    let (mut h, job) = funded_with_mandate(15 * USDC, START + 3_600);
    h.set_time(START + 3_600);
    h.submit_quote(&job, &quote_args(h.now())).unwrap();
    assert_eq!(h.job(&job).status, status::QUOTED, "mandate expired");
}

#[test]
fn terms_hash_matches_independent_vector() {
    let mut quote = Quote::default();
    for (field, value) in [
        (&mut quote.item, 101),
        (&mut quote.service_fee, 102),
        (&mut quote.delivery_fee, 103),
        (&mut quote.tip, 104),
        (&mut quote.other, 105),
        (&mut quote.ceiling, 600),
    ] {
        field.set(value);
    }
    let mut job = Job {
        quote_currency: *b"PLN",
        quote_exponent: 2,
        quote,
        quote_hash: [9; 32],
        ..Job::default()
    };
    job.release_cap.set(15_000_000);
    job.quote_expires_at.set(1_800_001_800);
    job.fee_bps.set(500);
    let job_key = Address::new_from_array([4; 32]);

    let mut expected = Sha256::new();
    expected.update(b"will-escrow:terms:v1");
    expected.update(ID.as_ref());
    expected.update([4u8; 32]);
    expected.update(b"PLN");
    expected.update([2u8]);
    for value in [101u64, 102, 103, 104, 105, 600, 15_000_000] {
        expected.update(value.to_le_bytes());
    }
    expected.update([9u8; 32]);
    expected.update(1_800_001_800i64.to_le_bytes());
    expected.update(500u16.to_le_bytes());
    assert_eq!(
        terms_hash(&job_key, &job),
        <[u8; 32]>::from(expected.finalize())
    );
}
