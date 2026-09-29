//! The IDL's account lists, from which the TypeScript client is generated,
//! must match the order and flags of the harness builders that every program
//! test runs with.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    serde_json::Value,
    solana_instruction::Instruction,
    solana_signer::Signer,
    will_escrow::{
        util::{SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID},
        Address, PROGRAM_DATA,
    },
};

fn idl_instruction(name: &str) -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/idl/will_escrow.json");
    let idl: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    idl["program"]["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|instruction| instruction["name"] == name)
        .unwrap_or_else(|| panic!("{name} is not in the IDL"))
        .clone()
}

/// `instruction` must list the IDL's accounts in order, each at the address
/// `addresses` gives its name and with the IDL's flags, then `trailing`.
fn check(
    name: &str,
    instruction: &Instruction,
    addresses: &[(&str, Address)],
    trailing: &[Address],
) {
    let node = idl_instruction(name);
    let accounts = node["accounts"].as_array().unwrap();
    assert_eq!(
        instruction.accounts.len(),
        accounts.len() + trailing.len(),
        "{name}: count"
    );
    for (meta, account) in instruction.accounts.iter().zip(accounts) {
        let account_name = account["name"].as_str().unwrap();
        let (_, address) = addresses
            .iter()
            .find(|(candidate, _)| *candidate == account_name)
            .unwrap_or_else(|| panic!("{name}: no address for {account_name}"));
        assert_eq!(&meta.pubkey, address, "{name}.{account_name}: position");
        assert_eq!(
            meta.is_writable,
            account["isWritable"] == true,
            "{name}.{account_name}: writable"
        );
        assert_eq!(
            meta.is_signer,
            account["isSigner"] == true,
            "{name}.{account_name}: signer"
        );
    }
    let rest: Vec<Address> = instruction.accounts[accounts.len()..]
        .iter()
        .map(|m| m.pubkey)
        .collect();
    assert_eq!(rest, trailing, "{name}: trailing accounts");
}

#[test]
fn idl_accounts_match_the_harness() {
    let mut h = Harness::new();
    h.init_config();
    let job = h.create_job(1, 20 * USDC);
    let hash = [1; 32];
    let addresses = [
        ("config", config_address()),
        ("job", job),
        ("vault", vault_address(&job)),
        ("customer", h.customer.pubkey()),
        ("customerToken", h.customer_token),
        ("rentPayer", h.job(&job).rent_payer),
        ("operator", h.operator.pubkey()),
        ("operatorToken", h.operator_token),
        ("treasuryToken", h.treasury_token),
        ("funding", h.funding),
        ("admin", h.admin.pubkey()),
        ("upgradeAuthority", h.upgrade_authority.pubkey()),
        ("programData", PROGRAM_DATA),
        ("mint", h.mint),
        ("tokenProgram", TOKEN_PROGRAM_ID),
        ("systemProgram", SYSTEM_PROGRAM_ID),
        ("signer", h.stranger.pubkey()),
        ("caller", h.stranger.pubkey()),
    ];
    let config = h.config();
    let update = will_escrow::instructions::update_config::UpdateConfig {
        fee_bps: config.fee_bps,
        dispute_window: config.dispute_window,
        job_timeout: config.job_timeout,
        dispute_timeout: config.dispute_timeout,
        paused: 0,
        new_admin: config.admin,
        operator: config.operator,
        treasury: config.treasury,
    };
    let cases: Vec<(&str, Instruction, Vec<Address>)> = vec![
        ("initializeConfig", h.init_config_ix(), vec![h.funding]),
        ("updateConfig", h.update_config_ix(&update), vec![h.funding]),
        (
            "createJob",
            h.create_job_ix(
                &job_args(1, 20 * USDC),
                h.customer.pubkey(),
                h.customer_token,
                h.job(&job).rent_payer,
                h.mint,
            ),
            vec![],
        ),
        (
            "submitQuote",
            h.submit_quote_ix(&job, h.operator.pubkey(), &quote_args(START)),
            vec![],
        ),
        (
            "approveQuote",
            h.approve_ix(&job, h.customer.pubkey(), hash),
            vec![],
        ),
        (
            "releaseForPurchase",
            h.release_ix(&job, h.funding, h.operator.pubkey(), 1),
            vec![],
        ),
        (
            "recordPurchase",
            h.record_ix(&job, h.operator.pubkey(), h.operator_token, hash, 1, 1),
            vec![],
        ),
        (
            "submitProof",
            h.proof_ix(&job, h.operator.pubkey(), hash),
            vec![],
        ),
        ("dispute", h.dispute_ix(&job, h.customer.pubkey()), vec![]),
        (
            "settle",
            h.settle_ix(
                &job,
                h.stranger.pubkey(),
                h.customer_token,
                h.treasury_token,
            ),
            vec![],
        ),
        (
            "resolveDispute",
            h.resolve_ix(&job, h.admin.pubkey(), 0),
            vec![],
        ),
        (
            "cancel",
            h.cancel_ix(&job, h.stranger.pubkey(), h.customer_token, 0, None),
            vec![],
        ),
        (
            "cancel",
            h.cancel_ix(
                &job,
                h.stranger.pubkey(),
                h.customer_token,
                1,
                Some(h.operator_token),
            ),
            vec![h.operator_token],
        ),
        (
            "refundExpired",
            h.refund_expired_ix(&job, h.customer_token, h.job(&job).rent_payer),
            vec![],
        ),
    ];
    for (name, instruction, trailing) in &cases {
        check(name, instruction, &addresses, trailing);
    }

    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/idl/will_escrow.json");
    let idl: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut all: Vec<&str> = idl["program"]["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|instruction| instruction["name"].as_str().unwrap())
        .collect();
    let mut checked: Vec<&str> = cases.iter().map(|(name, ..)| *name).collect();
    all.sort_unstable();
    checked.sort_unstable();
    checked.dedup();
    assert_eq!(checked, all, "every instruction is checked");
}
