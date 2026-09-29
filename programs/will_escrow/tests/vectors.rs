//! Encoding vectors for the TypeScript client in `clients/will-escrow-ts`.
//! Each case pairs JSON inputs with the bytes the program parses; the client's
//! test suite encodes the same inputs and decodes the same account bytes.
//! Regenerate with `UPDATE_VECTORS=1 cargo test -p will_escrow --test vectors`.

mod common;

use {
    common::{config_address, data, job_address, pda, vault_address},
    serde_json::{json, Value},
    std::path::Path,
    will_escrow::{
        instructions::{
            approve_quote, cancel, create_job, dispute, initialize_config, record_purchase,
            refund_expired, release_for_purchase, resolve_dispute, settle, submit_proof,
            submit_quote, update_config,
        },
        state::{Config, Job, LeI64, LeU16, LeU32, LeU64, Quote},
        util::bytes_of,
        Address, ID, PROGRAM_DATA,
    },
};

fn u16le(value: u16) -> LeU16 {
    let mut le = LeU16::default();
    le.set(value);
    le
}

fn u32le(value: u32) -> LeU32 {
    let mut le = LeU32::default();
    le.set(value);
    le
}

fn u64le(value: u64) -> LeU64 {
    let mut le = LeU64::default();
    le.set(value);
    le
}

fn i64le(value: i64) -> LeI64 {
    let mut le = LeI64::default();
    le.set(value);
    le
}

fn address(byte: u8) -> Address {
    Address::new_from_array([byte; 32])
}

/// 32 distinct bytes, so a reversed or shifted hash cannot match.
fn hash(start: u8) -> [u8; 32] {
    core::array::from_fn(|i| start.wrapping_add(i as u8))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn quote() -> (Quote, Value) {
    let quote = Quote {
        item: u64le(4_500),
        service_fee: u64le(299),
        delivery_fee: u64le(599),
        tip: u64le(1),
        other: u64le(2),
        ceiling: u64le(6_000),
    };
    let json = json!({
        "item": "4500", "serviceFee": "299", "deliveryFee": "599",
        "tip": "1", "other": "2", "ceiling": "6000",
    });
    (quote, json)
}

fn case<T>(name: &str, discriminator: u8, args: &T, json: Value) -> Value {
    json!({ "name": name, "args": json, "data": hex(&data(discriminator, args)) })
}

fn instructions() -> Value {
    let [a, b, c] = [address(0x11), address(0x22), address(0x33)];
    let (quote, quote_json) = quote();
    Value::Array(vec![
        case(
            "initializeConfig",
            initialize_config::DISCRIMINATOR,
            &initialize_config::InitializeConfig {
                fee_bps: u16le(500),
                dispute_window: u32le(86_400),
                job_timeout: u32le(604_800),
                dispute_timeout: u32le(1_209_600),
                admin: a,
                operator: b,
                treasury: c,
            },
            json!({
                "feeBps": 500, "disputeWindow": 86_400, "jobTimeout": 604_800,
                "disputeTimeout": 1_209_600, "admin": a.to_string(),
                "operator": b.to_string(), "treasury": c.to_string(),
            }),
        ),
        case(
            "updateConfig",
            update_config::DISCRIMINATOR,
            &update_config::UpdateConfig {
                fee_bps: u16le(1_000),
                dispute_window: u32le(0x0102_0304),
                job_timeout: u32le(0x0506_0708),
                dispute_timeout: u32le(0x090a_0b0c),
                paused: 1,
                new_admin: c,
                operator: a,
                treasury: b,
            },
            json!({
                "feeBps": 1_000, "disputeWindow": 0x0102_0304, "jobTimeout": 0x0506_0708,
                "disputeTimeout": 0x090a_0b0c, "paused": 1, "newAdmin": c.to_string(),
                "operator": a.to_string(), "treasury": b.to_string(),
            }),
        ),
        case(
            "createJob",
            create_job::DISCRIMINATOR,
            &create_job::CreateJob {
                job_id: u64le(0x0102_0304_0506_0708),
                budget: u64le(0x1122_3344_5566_7788),
                job_kind: 3,
                adapter: 15,
                mandate_cap: u64le(15_000_000),
                mandate_expires_at: i64le(-2),
            },
            json!({
                "jobId": "72623859790382856", "budget": "1234605616436508552",
                "jobKind": 3, "adapter": 15, "mandateCap": "15000000",
                "mandateExpiresAt": "-2",
            }),
        ),
        case(
            "submitQuote",
            submit_quote::DISCRIMINATOR,
            &submit_quote::SubmitQuote {
                quote_currency: *b"PLN",
                quote_exponent: 2,
                quote,
                total: u64le(5_401),
                release_cap: u64le(15_000_000),
                quote_expires_at: i64le(1_800_001_800),
                quote_hash: hash(0),
            },
            json!({
                "quoteCurrency": "PLN", "quoteExponent": 2, "quote": quote_json,
                "total": "5401", "releaseCap": "15000000", "quoteExpiresAt": "1800001800",
                "quoteHash": hex(&hash(0)),
            }),
        ),
        case(
            "approveQuote",
            approve_quote::DISCRIMINATOR,
            &approve_quote::ApproveQuote {
                terms_hash: hash(0x40),
            },
            json!({ "termsHash": hex(&hash(0x40)) }),
        ),
        case(
            "releaseForPurchase",
            release_for_purchase::DISCRIMINATOR,
            &release_for_purchase::ReleaseForPurchase {
                amount: u64le(u64::MAX),
            },
            json!({ "amount": u64::MAX.to_string() }),
        ),
        case(
            "recordPurchase",
            record_purchase::DISCRIMINATOR,
            &record_purchase::RecordPurchase {
                order_ref_hash: hash(0x80),
                charged: u64le(13_333_337),
                charged_quote_amount: u64le(5_398),
            },
            json!({
                "orderRefHash": hex(&hash(0x80)), "charged": "13333337",
                "chargedQuoteAmount": "5398",
            }),
        ),
        case(
            "submitProof",
            submit_proof::DISCRIMINATOR,
            &submit_proof::SubmitProof {
                proof_hash: hash(0xa0),
            },
            json!({ "proofHash": hex(&hash(0xa0)) }),
        ),
        case(
            "dispute",
            dispute::DISCRIMINATOR,
            &dispute::Dispute {
                reason_hash: hash(0xc0),
            },
            json!({ "reasonHash": hex(&hash(0xc0)) }),
        ),
        case(
            "settle",
            settle::DISCRIMINATOR,
            &settle::Settle {},
            json!({}),
        ),
        case(
            "resolveDispute",
            resolve_dispute::DISCRIMINATOR,
            &resolve_dispute::ResolveDispute {
                fee_to_operator: u64le(666_666),
            },
            json!({ "feeToOperator": "666666" }),
        ),
        case(
            "cancel",
            cancel::DISCRIMINATOR,
            &cancel::Cancel { returned: u64le(1) },
            json!({ "returned": "1" }),
        ),
        case(
            "refundExpired",
            refund_expired::DISCRIMINATOR,
            &refund_expired::RefundExpired {},
            json!({}),
        ),
    ])
}

fn accounts() -> Value {
    let (quote, quote_json) = quote();
    let [a, b, c, d, e] = [0x11, 0x22, 0x33, 0x44, 0x55].map(address);
    let config = Config {
        tag: 1,
        version: 1,
        bump: 255,
        paused: 1,
        fee_bps: u16le(500),
        dispute_window: u32le(86_400),
        job_timeout: u32le(604_800),
        dispute_timeout: u32le(1_209_600),
        admin: a,
        operator: b,
        treasury: c,
        mint: d,
        funding_count: 2,
        funding: [e, a, Address::default(), Address::default()],
    };
    let job = Job {
        tag: 2,
        version: 1,
        status: 6,
        bump: 254,
        vault_bump: 253,
        job_kind: 3,
        adapter: 15,
        quote_exponent: 2,
        quote_currency: *b"PLN",
        flags: 1,
        fee_bps: u16le(500),
        customer: a,
        rent_payer: b,
        job_id: u64le(7),
        budget: u64le(20_000_000),
        fee_reserve: u64le(1_000_000),
        mandate_cap: u64le(15_000_000),
        mandate_expires_at: i64le(1_800_003_600),
        expires_at: i64le(1_800_604_800),
        quote,
        release_cap: u64le(15_000_000),
        quote_expires_at: i64le(1_800_001_800),
        quote_hash: hash(0),
        released: u64le(15_000_000),
        charged: u64le(13_333_337),
        charged_quote_amount: u64le(5_398),
        order_ref_hash: hash(0x80),
        proof_hash: hash(0xa0),
        window_ends_at: i64le(1_800_090_000),
        dispute_expires_at: i64le(-1),
    };
    let default = Address::default().to_string();
    json!({
        "config": {
            "data": hex(bytes_of(&config)),
            "fields": {
                "tag": 1, "version": 1, "bump": 255, "paused": 1, "feeBps": 500,
                "disputeWindow": 86_400, "jobTimeout": 604_800, "disputeTimeout": 1_209_600,
                "admin": a.to_string(), "operator": b.to_string(),
                "treasury": c.to_string(), "mint": d.to_string(), "fundingCount": 2,
                "funding": [e.to_string(), a.to_string(), default, default],
            },
        },
        "job": {
            "data": hex(bytes_of(&job)),
            "fields": {
                "tag": 2, "version": 1, "status": 6, "bump": 254, "vaultBump": 253,
                "jobKind": 3, "adapter": 15, "quoteExponent": 2,
                "quoteCurrency": "PLN", "flags": 1, "feeBps": 500,
                "customer": a.to_string(), "rentPayer": b.to_string(), "jobId": "7",
                "budget": "20000000", "feeReserve": "1000000", "mandateCap": "15000000",
                "mandateExpiresAt": "1800003600", "expiresAt": "1800604800",
                "quote": quote_json, "releaseCap": "15000000",
                "quoteExpiresAt": "1800001800", "quoteHash": hex(&hash(0)),
                "released": "15000000", "charged": "13333337",
                "chargedQuoteAmount": "5398", "orderRefHash": hex(&hash(0x80)),
                "proofHash": hex(&hash(0xa0)), "windowEndsAt": "1800090000",
                "disputeExpiresAt": "-1",
            },
        },
    })
}

fn pdas() -> Value {
    let customer = address(0x11);
    let job_id = 0x0102_0304_0506_0708u64;
    let job = job_address(&customer, job_id);
    let (_, config_bump) = pda(&[b"config"]);
    let (_, job_bump) = pda(&[b"job", customer.as_ref(), &job_id.to_le_bytes()]);
    let (_, vault_bump) = pda(&[b"vault", job.as_ref()]);
    json!({
        "programId": ID.to_string(),
        "programData": PROGRAM_DATA.to_string(),
        "config": { "address": config_address().to_string(), "bump": config_bump },
        "job": {
            "customer": customer.to_string(), "jobId": job_id.to_string(),
            "address": job.to_string(), "bump": job_bump,
        },
        "vault": {
            "job": job.to_string(), "address": vault_address(&job).to_string(),
            "bump": vault_bump,
        },
    })
}

fn check(name: &str, value: Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/vectors")
        .join(format!("{name}.json"));
    let mut rendered = serde_json::to_string_pretty(&value).unwrap();
    rendered.push('\n');
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert_eq!(
        committed, rendered,
        "stale {name}.json: rerun with UPDATE_VECTORS=1"
    );
}

#[test]
fn instruction_vectors_are_current() {
    check("instructions", instructions());
}

#[test]
fn account_vectors_are_current() {
    let value = accounts();
    assert_eq!(value["config"]["data"].as_str().unwrap().len(), 2 * 275);
    assert_eq!(value["job"]["data"].as_str().unwrap().len(), 2 * 326);
    check("accounts", value);
}

#[test]
fn pda_vectors_are_current() {
    check("pdas", pdas());
}
