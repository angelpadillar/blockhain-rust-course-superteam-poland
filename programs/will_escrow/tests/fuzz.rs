//! Model-based fuzz: random sequences of instructions, signers, amounts and
//! clock jumps run on the program and on `model::Model`; after every step the
//! outcome, token balances and each job's existence and state must agree.
//! `PROPTEST_CASES` (default 256) sets the number of sequences.
#![allow(clippy::result_large_err)]

mod common;
mod model;

use {
    common::*,
    model::{Model, Op},
    proptest::prelude::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
    will_escrow::{instructions::approve_quote::terms_hash, Address},
};

/// A charge whose 5% fee is fractional (666_666.85), so floor and ceiling
/// differ and fee rounding is exercised.
const ODD_CHARGE: u64 = 13_333_337;

/// Mostly `usual`, sometimes any of the edge amounts.
fn amount(usual: u64) -> impl Strategy<Value = u64> {
    prop_oneof![
        6 => Just(usual),
        1 => Just(0),
        1 => Just(1),
        1 => Just(12 * USDC),
        1 => Just(15 * USDC - 1),
        1 => Just(15 * USDC + 1),
        1 => Just(u64::MAX),
    ]
}

/// Mostly the signer the instruction expects, sometimes anyone else
/// (0 customer, 1 operator, 2 admin, 3 stranger).
fn signer(usual: usize) -> impl Strategy<Value = usize> {
    prop_oneof![7 => Just(usual), 1 => Just(0usize), 1 => Just(1usize), 1 => Just(2usize), 1 => Just(3usize)]
}

fn op() -> impl Strategy<Value = Op> {
    let id = prop_oneof![3 => Just(0u64), 1 => Just(1u64)];
    prop_oneof![
        2 => (id.clone(), prop_oneof![6 => Just(20 * USDC), 1 => Just(1), 1 => Just(990 * USDC), 1 => Just(u64::MAX)],
              prop_oneof![3 => Just(0), 1 => Just(15 * USDC)], prop_oneof![Just(0i64), Just(3_600), Just(7 * 86_400 + 1)])
            .prop_map(|(id, budget, mandate_cap, mandate_ttl)| Op::Create { id, budget, mandate_cap, mandate_ttl }),
        3 => (id.clone(), signer(1), amount(15 * USDC), prop_oneof![5 => Just(true), 1 => Just(false)])
            .prop_map(|(id, signer, release_cap, valid)| Op::Quote { id, signer, release_cap, valid }),
        3 => (id.clone(), signer(0)).prop_map(|(id, signer)| Op::Approve { id, signer }),
        3 => (id.clone(), signer(1), amount(15 * USDC)).prop_map(|(id, signer, amount)| Op::Release { id, signer, amount }),
        3 => (id.clone(), signer(1), prop_oneof![3 => Just(ODD_CHARGE), 2 => amount(13 * USDC)])
            .prop_map(|(id, signer, charged)| Op::Record { id, signer, charged }),
        3 => (id.clone(), signer(1)).prop_map(|(id, signer)| Op::Prove { id, signer }),
        1 => (id.clone(), signer(0)).prop_map(|(id, signer)| Op::Dispute { id, signer }),
        2 => (id.clone(), prop_oneof![Just(0usize), Just(3usize), Just(1usize)]).prop_map(|(id, signer)| Op::Settle { id, signer }),
        1 => (id.clone(), signer(2), prop_oneof![Just(0), Just(1), Just(100_000), Just(u64::MAX)])
            .prop_map(|(id, signer, fee)| Op::Resolve { id, signer, fee }),
        1 => (id.clone(), prop_oneof![Just(0usize), Just(1usize), Just(3usize)], prop_oneof![3 => Just(0), 1 => Just(1)])
            .prop_map(|(id, signer, extra)| Op::Cancel { id, signer, extra }),
        1 => id.clone().prop_map(|id| Op::Refund { id }),
        3 => prop_oneof![5 => Just(1i64), 3 => Just(60), 2 => Just(1_800), 1 => Just(86_400), 1 => Just(7 * 86_400), 1 => Just(14 * 86_400)]
            .prop_map(|seconds| Op::Advance { seconds }),
        1 => prop_oneof![1 => Just(true), 3 => Just(false)].prop_map(|on| Op::Pause { on }),
    ]
}

struct Runner {
    h: Harness,
    signers: [Keypair; 4],
}

impl Runner {
    fn new() -> Self {
        let mut h = Harness::new();
        h.init_config();
        let signers = [
            copy(&h.customer),
            copy(&h.operator),
            copy(&h.admin),
            copy(&h.stranger),
        ];
        Self { h, signers }
    }

    fn job(&self, id: u64) -> Address {
        job_address(&self.h.customer.pubkey(), id)
    }

    fn model(&self) -> Model {
        Model {
            now: self.h.now(),
            paused: false,
            fee_bps: u64::from(FEE_BPS),
            dispute_window: i64::from(DISPUTE_WINDOW),
            job_timeout: i64::from(JOB_TIMEOUT),
            dispute_timeout: i64::from(DISPUTE_TIMEOUT),
            customer: self.h.token_balance(&self.h.customer_token),
            operator: self.h.token_balance(&self.h.operator_token),
            treasury: self.h.token_balance(&self.h.treasury_token),
            funding: self.h.token_balance(&self.h.funding),
            jobs: Default::default(),
        }
    }

    fn execute(&mut self, op: &Op, missing: u64) -> bool {
        let h = &mut self.h;
        let signer = |i: usize| copy(&self.signers[i]);
        let result = match *op {
            Op::Advance { seconds } => {
                h.set_time(h.now() + seconds);
                return true;
            }
            Op::Pause { on } => {
                h.set_paused(on);
                return true;
            }
            Op::Create {
                id,
                budget,
                mandate_cap,
                mandate_ttl,
            } => {
                let mut args = job_args(id, budget);
                args.mandate_cap.set(mandate_cap);
                args.mandate_expires_at.set(h.now() + mandate_ttl);
                let instruction = h.create_job_ix(
                    &args,
                    h.customer.pubkey(),
                    h.customer_token,
                    h.operator.pubkey(),
                    h.mint,
                );
                let (operator, customer) = (signer(1), signer(0));
                h.send(instruction, &[&operator, &customer])
            }
            Op::Quote {
                id,
                signer: s,
                release_cap,
                valid,
            } => {
                let mut args = quote_args(h.now());
                args.release_cap.set(release_cap);
                if !valid {
                    args.total.set(args.total.get() + 1);
                }
                let job = job_address(&h.customer.pubkey(), id);
                let instruction = h.submit_quote_ix(&job, signer(s).pubkey(), &args);
                h.send(instruction, &[&signer(s)])
            }
            Op::Approve { id, signer: s } => {
                let job = job_address(&h.customer.pubkey(), id);
                let terms = h
                    .account(&job)
                    .map_or([1; 32], |_| terms_hash(&job, &h.job(&job)));
                let instruction = h.approve_ix(&job, signer(s).pubkey(), terms);
                h.send(instruction, &[&signer(s)])
            }
            Op::Release {
                id,
                signer: s,
                amount,
            } => {
                let job = job_address(&h.customer.pubkey(), id);
                let instruction = h.release_ix(&job, h.funding, signer(s).pubkey(), amount);
                h.send(instruction, &[&signer(s)])
            }
            Op::Record {
                id,
                signer: s,
                charged,
            } => {
                let job = job_address(&h.customer.pubkey(), id);
                let source = if s == 1 {
                    h.operator_token
                } else {
                    h.stranger_token
                };
                let instruction =
                    h.record_ix(&job, signer(s).pubkey(), source, [5; 32], charged, 5_398);
                h.send(instruction, &[&signer(s)])
            }
            Op::Prove { id, signer: s } => {
                let job = job_address(&h.customer.pubkey(), id);
                let instruction = h.proof_ix(&job, signer(s).pubkey(), [6; 32]);
                h.send(instruction, &[&signer(s)])
            }
            Op::Dispute { id, signer: s } => {
                let job = job_address(&h.customer.pubkey(), id);
                let instruction = h.dispute_ix(&job, signer(s).pubkey());
                h.send(instruction, &[&signer(s)])
            }
            Op::Settle { id, signer: s } => {
                let job = job_address(&h.customer.pubkey(), id);
                if h.account(&job).is_none() {
                    return false;
                }
                h.settle(&job, &signer(s))
            }
            Op::Resolve { id, signer: s, fee } => {
                let job = job_address(&h.customer.pubkey(), id);
                if h.account(&job).is_none() {
                    return false;
                }
                let instruction = h.resolve_ix(&job, signer(s).pubkey(), fee);
                h.send(instruction, &[&signer(s)])
            }
            Op::Cancel {
                id,
                signer: s,
                extra,
            } => {
                let job = job_address(&h.customer.pubkey(), id);
                if h.account(&job).is_none() {
                    return false;
                }
                let (returned, source) = if s == 1 {
                    (missing + extra, Some(h.operator_token))
                } else {
                    (extra, Some(h.customer_token))
                };
                let instruction =
                    h.cancel_ix(&job, signer(s).pubkey(), h.customer_token, returned, source);
                h.send(instruction, &[&signer(s)])
            }
            Op::Refund { id } => {
                let job = job_address(&h.customer.pubkey(), id);
                if h.account(&job).is_none() {
                    return false;
                }
                let instruction =
                    h.refund_expired_ix(&job, h.customer_token, h.job(&job).rent_payer);
                h.send(instruction, &[&signer(3)])
            }
        };
        result.is_ok()
    }

    fn check(&self, model: &Model, step: usize, op: &Op) -> Result<(), TestCaseError> {
        let h = &self.h;
        let context = || format!("step {step}: {op:?}");
        prop_assert_eq!(
            h.token_balance(&h.customer_token),
            model.customer,
            "customer, {}",
            context()
        );
        prop_assert_eq!(
            h.token_balance(&h.operator_token),
            model.operator,
            "operator, {}",
            context()
        );
        prop_assert_eq!(
            h.token_balance(&h.treasury_token),
            model.treasury,
            "treasury, {}",
            context()
        );
        prop_assert_eq!(
            h.token_balance(&h.funding),
            model.funding,
            "funding, {}",
            context()
        );
        for id in 0..3 {
            let job = self.job(id);
            match model.jobs.get(&id) {
                None => prop_assert!(
                    h.account(&job).is_none(),
                    "job {} should be closed, {}",
                    id,
                    context()
                ),
                Some(expected) => {
                    let actual = h.job(&job);
                    prop_assert_eq!(
                        actual.status,
                        expected.status,
                        "job {} status, {}",
                        id,
                        context()
                    );
                    prop_assert_eq!(
                        actual.released.get(),
                        expected.released,
                        "job {} released, {}",
                        id,
                        context()
                    );
                    prop_assert_eq!(
                        actual.charged.get(),
                        expected.charged,
                        "job {} charged, {}",
                        id,
                        context()
                    );
                    prop_assert_eq!(
                        h.token_balance(&vault_address(&job)),
                        expected.vault,
                        "job {} vault, {}",
                        id,
                        context()
                    );
                }
            }
        }
        Ok(())
    }
}

/// Valid steps taking job `id` from nothing to `target` (0 = FUNDED ..
/// 6 = DISPUTED).
fn lifecycle(id: u64, target: u8) -> Vec<Op> {
    let steps = [
        Op::Create {
            id,
            budget: 20 * USDC,
            mandate_cap: 0,
            mandate_ttl: 0,
        },
        Op::Quote {
            id,
            signer: 1,
            release_cap: 15 * USDC,
            valid: true,
        },
        Op::Approve { id, signer: 0 },
        Op::Release {
            id,
            signer: 1,
            amount: 15 * USDC,
        },
        Op::Record {
            id,
            signer: 1,
            charged: ODD_CHARGE,
        },
        Op::Prove { id, signer: 1 },
        Op::Dispute { id, signer: 0 },
    ];
    steps.into_iter().take(usize::from(target) + 1).collect()
}

fn kind(op: &Op) -> &'static str {
    match op {
        Op::Create { .. } => "create",
        Op::Quote { .. } => "quote",
        Op::Approve { .. } => "approve",
        Op::Release { .. } => "release",
        Op::Record { .. } => "record",
        Op::Prove { .. } => "prove",
        Op::Dispute { .. } => "dispute",
        Op::Settle { .. } => "settle",
        Op::Resolve { .. } => "resolve",
        Op::Cancel { .. } => "cancel",
        Op::Refund { .. } => "refund",
        Op::Advance { .. } => "advance",
        Op::Pause { .. } => "pause",
    }
}

#[test]
fn program_matches_model() {
    let cases = std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(256);
    let mut runner = proptest::test_runner::TestRunner::new(ProptestConfig::with_cases(cases));
    let successes = std::cell::RefCell::new(std::collections::BTreeMap::<&str, u32>::new());
    let strategy = (0u8..7, 0u8..7, prop::collection::vec(op(), 1..40));
    let result = runner.run(&strategy, |(target0, target1, random)| {
        let mut runner = Runner::new();
        let mut model = runner.model();
        // Start from deep states: each job is driven to a random target
        // state with valid steps, which must succeed on both sides.
        let mut prefix = lifecycle(0, target0);
        prefix.extend(lifecycle(1, target1));
        let prefix_len = prefix.len();
        let ops: Vec<Op> = prefix.into_iter().chain(random).collect();
        for (step, op) in ops.iter().enumerate() {
            let missing = model.missing(match *op {
                Op::Cancel { id, .. } => id,
                _ => 0,
            });
            let expected = model.apply(op);
            let actual = runner.execute(op, missing);
            prop_assert_eq!(actual, expected, "outcome at step {}: {:?}", step, op);
            if step < prefix_len {
                prop_assert!(actual, "lifecycle step {} failed: {:?}", step, op);
            }
            runner.check(&model, step, op)?;
            if actual {
                *successes.borrow_mut().entry(kind(op)).or_default() += 1;
            }
        }
        Ok(())
    });
    if let Err(failure) = result {
        panic!("{failure}");
    }
    let successes = successes.into_inner();
    println!("{cases} sequences; successful operations: {successes:?}");
    // A walk that never reaches the later states would prove little.
    for kind in [
        "create", "quote", "approve", "release", "record", "prove", "dispute", "settle", "resolve",
        "cancel", "refund",
    ] {
        assert!(
            successes.get(kind).copied().unwrap_or(0) > 0,
            "{kind} never succeeded"
        );
    }
}
