//! Compute units per instruction, measured as the v1 parity suite measured
//! the Anchor program: LiteSVM's `compute_units_consumed` for a transaction
//! holding only that instruction, CPIs included. The measurements must equal
//! the table in COSTS.md, so it cannot silently go stale; a failure prints the
//! measured rows.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    litesvm::types::TransactionResult,
    solana_signer::Signer,
    will_escrow::{instructions::update_config::UpdateConfig, state::status},
};

struct Table(Vec<(&'static str, u64)>);

impl Table {
    fn record(&mut self, label: &'static str, result: TransactionResult) {
        let meta = result.unwrap_or_else(|failed| panic!("{label}: {:?}", failed.err));
        self.0.push((label, meta.compute_units_consumed));
    }
}

#[test]
fn compute_units_per_instruction() {
    let mut table = Table(Vec::new());
    let mut h = Harness::new();
    let (upgrade_authority, admin) = (copy(&h.upgrade_authority), copy(&h.admin));
    let (operator, customer, stranger) = (copy(&h.operator), copy(&h.customer), copy(&h.stranger));

    let instruction = h.init_config_ix();
    table.record(
        "initialize_config (1 funding account)",
        h.send(instruction, &[&upgrade_authority]),
    );
    let config = h.config();
    let update = UpdateConfig {
        fee_bps: config.fee_bps,
        dispute_window: config.dispute_window,
        job_timeout: config.job_timeout,
        dispute_timeout: config.dispute_timeout,
        paused: 0,
        new_admin: config.admin,
        operator: config.operator,
        treasury: config.treasury,
    };
    let instruction = h.update_config_ix(&update);
    table.record("update_config", h.send(instruction, &[&admin]));

    // create_job searches for both canonical bumps, and every failed attempt
    // costs extra, so the figure depends on the address. Measure the floor
    // (both bumps 255) and one extra attempt.
    let bumps = |id: u64| {
        let job = job_address(&customer.pubkey(), id);
        let job_bump = pda(&[b"job", customer.pubkey().as_ref(), &id.to_le_bytes()]).1;
        (job_bump, pda(&[b"vault", job.as_ref()]).1)
    };
    let floor = (100..).find(|id| bumps(*id) == (255, 255)).unwrap();
    let one_more = (100..).find(|id| bumps(*id) == (254, 255)).unwrap();
    for (label, id) in [
        ("create_job (both bumps 255)", floor),
        ("create_job (one extra bump attempt)", one_more),
    ] {
        let instruction = h.create_job_ix(
            &job_args(id, 20 * USDC),
            customer.pubkey(),
            h.customer_token,
            operator.pubkey(),
            h.mint,
        );
        table.record(label, h.send(instruction, &[&operator, &customer]));
    }

    // The happy path, with the customer signing off early.
    let job = job_address(&customer.pubkey(), floor);
    table.record("submit_quote", h.submit_quote(&job, &quote_args(h.now())));
    table.record("approve_quote", h.approve(&job));
    table.record("release_for_purchase", h.release(&job, 15 * USDC));
    table.record(
        "record_purchase (returns excess)",
        h.record(&job, 13 * USDC),
    );
    table.record("submit_proof", h.prove(&job));
    table.record("settle (fee + refund + close)", h.settle(&job, &customer));

    // A mandate approves the quote inside submit_quote.
    let mut args = job_args(2, 20 * USDC);
    args.mandate_cap.set(15 * USDC);
    args.mandate_expires_at.set(h.now() + 3_600);
    let instruction = h.create_job_ix(
        &args,
        customer.pubkey(),
        h.customer_token,
        operator.pubkey(),
        h.mint,
    );
    h.send(instruction, &[&operator, &customer]).unwrap();
    let job = job_address(&customer.pubkey(), 2);
    table.record(
        "submit_quote (mandate approves)",
        h.submit_quote(&job, &quote_args(h.now())),
    );
    assert_eq!(h.job(&job).status, status::APPROVED);

    // Dispute, resolved with the earned fee to the operator.
    let job = h.proven_job(3);
    table.record("dispute", h.dispute(&job));
    let earned = h.job(&job).charged.get() * u64::from(h.job(&job).fee_bps.get()) / 10_000;
    let instruction = h.resolve_ix(&job, admin.pubkey(), earned);
    table.record("resolve_dispute", h.send(instruction, &[&admin]));

    // Exits.
    let job = h.create_job(4, 20 * USDC);
    let instruction = h.cancel_ix(&job, customer.pubkey(), h.customer_token, 0, None);
    table.record(
        "cancel (customer, before approval)",
        h.send(instruction, &[&customer]),
    );
    let job = h.approved_job(5, 20 * USDC);
    h.release(&job, 15 * USDC).unwrap();
    let instruction = h.cancel_ix(
        &job,
        operator.pubkey(),
        h.customer_token,
        15 * USDC,
        Some(h.operator_token),
    );
    table.record(
        "cancel (operator, returns release)",
        h.send(instruction, &[&operator]),
    );
    let job = h.create_job(6, 20 * USDC);
    h.set_time(h.job(&job).expires_at.get());
    let instruction = h.refund_expired_ix(&job, h.customer_token, operator.pubkey());
    table.record("refund_expired", h.send(instruction, &[&stranger]));

    let documented = documented_compute_units();
    let measured: Vec<(String, u64)> = table.0.iter().map(|(l, u)| (l.to_string(), *u)).collect();
    let rows: String = measured
        .iter()
        .map(|(l, u)| format!("| `{l}` | {u} |\n"))
        .collect();
    assert_eq!(documented, measured, "COSTS.md is stale; measured:\n{rows}");
}

/// The `| `label` | CU | ...` rows of COSTS.md's "## Compute units" table.
fn documented_compute_units() -> Vec<(String, u64)> {
    let costs = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/COSTS.md")).unwrap();
    let section = costs
        .split("\n## Compute units")
        .nth(1)
        .expect("a Compute units section");
    let section = section.split("\n## ").next().unwrap();
    section
        .lines()
        .filter(|line| line.starts_with("| `"))
        .map(|line| {
            let cells: Vec<&str> = line.split('|').map(str::trim).collect();
            let units = cells[2].replace(',', "").parse().unwrap();
            (cells[1].trim_matches('`').to_string(), units)
        })
        .collect()
}
