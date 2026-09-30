//! initialize_config and update_config.
#![allow(clippy::result_large_err)]

mod common;

use {
    common::*,
    solana_instruction::Instruction,
    solana_keypair::Keypair,
    solana_signer::Signer,
    will_escrow::{
        error::WillError,
        instructions::{
            initialize_config::{self, InitializeConfig},
            update_config::{self, UpdateConfig},
        },
        state::{LeU16, LeU32, CONFIG_TAG},
        Address, ID, PROGRAM_DATA,
    },
};

fn init_args(h: &Harness, fee_bps: u16) -> InitializeConfig {
    let mut args = InitializeConfig {
        fee_bps: LeU16::default(),
        dispute_window: LeU32::default(),
        job_timeout: LeU32::default(),
        dispute_timeout: LeU32::default(),
        admin: h.admin.pubkey(),
        operator: h.operator.pubkey(),
        treasury: h.treasury.pubkey(),
    };
    args.fee_bps.set(fee_bps);
    args.dispute_window.set(DISPUTE_WINDOW);
    args.job_timeout.set(JOB_TIMEOUT);
    args.dispute_timeout.set(DISPUTE_TIMEOUT);
    args
}

fn initialize(
    h: &mut Harness,
    authority: &Keypair,
    programdata: Address,
    args: &InitializeConfig,
    funding: &[Address],
) -> litesvm::types::TransactionResult {
    let mut accounts = vec![
        meta(config_address(), true, false),
        meta(authority.pubkey(), true, true),
        meta(programdata, false, false),
        meta(h.mint, false, false),
        meta(SYSTEM_PROGRAM, false, false),
    ];
    accounts.extend(funding.iter().map(|address| meta(*address, false, false)));
    let instruction = Instruction {
        program_id: ID,
        accounts,
        data: data(initialize_config::DISCRIMINATOR, args),
    };
    let authority = copy(authority);
    h.send(instruction, &[&authority])
}

fn init_default(h: &mut Harness) -> litesvm::types::TransactionResult {
    let args = init_args(h, FEE_BPS);
    let authority = copy(&h.upgrade_authority);
    let funding = [h.funding];
    initialize(h, &authority, PROGRAM_DATA, &args, &funding)
}

fn update_args(h: &Harness) -> UpdateConfig {
    let config = h.config();
    UpdateConfig {
        fee_bps: config.fee_bps,
        dispute_window: config.dispute_window,
        job_timeout: config.job_timeout,
        dispute_timeout: config.dispute_timeout,
        paused: config.paused,
        new_admin: config.admin,
        operator: config.operator,
        treasury: config.treasury,
    }
}

fn update(
    h: &mut Harness,
    signer: &Keypair,
    args: &UpdateConfig,
    funding: &[Address],
) -> litesvm::types::TransactionResult {
    let mut accounts = vec![
        meta(config_address(), true, false),
        meta(signer.pubkey(), false, true),
    ];
    accounts.extend(funding.iter().map(|address| meta(*address, false, false)));
    let instruction = Instruction {
        program_id: ID,
        accounts,
        data: data(update_config::DISCRIMINATOR, args),
    };
    let signer = copy(signer);
    h.send(instruction, &[&signer])
}

#[test]
fn program_data_constant_matches_derivation() {
    assert_eq!(
        PROGRAM_DATA,
        Address::find_program_address(&[ID.as_ref()], &LOADER_V3).0
    );
}

#[test]
fn init_by_upgrade_authority() {
    let mut h = Harness::new();
    init_default(&mut h).unwrap();
    let config = h.config();
    assert_eq!(config.tag, CONFIG_TAG);
    assert_eq!(config.paused, 0);
    assert_eq!(config.fee_bps.get(), FEE_BPS);
    assert_eq!(
        (
            config.dispute_window.get(),
            config.job_timeout.get(),
            config.dispute_timeout.get()
        ),
        (DISPUTE_WINDOW, JOB_TIMEOUT, DISPUTE_TIMEOUT)
    );
    assert_eq!(
        (config.admin, config.operator, config.treasury, config.mint),
        (
            h.admin.pubkey(),
            h.operator.pubkey(),
            h.treasury.pubkey(),
            h.mint
        )
    );
    assert_eq!(config.funding_count, 1);
    assert_eq!(config.funding[0], h.funding);
    assert_eq!(config.funding[1], Address::default());
}

#[test]
fn init_rejects_other_signer() {
    let mut h = Harness::new();
    let args = init_args(&h, FEE_BPS);
    let stranger = copy(&h.stranger);
    let funding = [h.funding];
    let result = initialize(&mut h, &stranger, PROGRAM_DATA, &args, &funding);
    assert_eq!(
        custom_error(&result),
        Some(WillError::NotUpgradeAuthority as u32)
    );
    assert!(h.account(&config_address()).is_none());
}

#[test]
fn init_rejects_fake_programdata() {
    // The stranger deploys their own program and is its upgrade authority; its
    // ProgramData must not authorize initializing this program's config.
    let mut h = Harness::new();
    let other_program = Keypair::new().pubkey();
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/will_escrow.so"
    ))
    .unwrap();
    h.svm.add_program(other_program, &bytes).unwrap();
    let other_programdata = Address::find_program_address(&[other_program.as_ref()], &LOADER_V3).0;
    let mut account = h.svm.get_account(&other_programdata).unwrap();
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(h.stranger.pubkey().as_ref());
    h.svm.set_account(other_programdata, account).unwrap();

    let args = init_args(&h, FEE_BPS);
    let stranger = copy(&h.stranger);
    let funding = [h.funding];
    let result = initialize(&mut h, &stranger, other_programdata, &args, &funding);
    assert_eq!(
        custom_error(&result),
        Some(WillError::NotUpgradeAuthority as u32)
    );
}

#[test]
fn init_twice_rejected() {
    let mut h = Harness::new();
    init_default(&mut h).unwrap();
    let before = h.account(&config_address()).unwrap();
    let mut args = init_args(&h, 100);
    args.operator = h.stranger.pubkey();
    let authority = copy(&h.upgrade_authority);
    let funding = [h.funding];
    assert!(initialize(&mut h, &authority, PROGRAM_DATA, &args, &funding).is_err());
    assert_eq!(h.account(&config_address()).unwrap(), before);
}

#[test]
fn init_rejects_fee_over_max() {
    let mut h = Harness::new();
    let args = init_args(&h, 1_001);
    let authority = copy(&h.upgrade_authority);
    let funding = [h.funding];
    let result = initialize(&mut h, &authority, PROGRAM_DATA, &args, &funding);
    assert_eq!(custom_error(&result), Some(WillError::BadAmount as u32));
}

#[test]
fn init_rejects_zero_timeouts() {
    for field in 0..3 {
        let mut h = Harness::new();
        let mut args = init_args(&h, FEE_BPS);
        match field {
            0 => args.dispute_window.set(0),
            1 => args.job_timeout.set(0),
            _ => args.dispute_timeout.set(0),
        }
        let authority = copy(&h.upgrade_authority);
        let funding = [h.funding];
        let result = initialize(&mut h, &authority, PROGRAM_DATA, &args, &funding);
        assert_eq!(
            custom_error(&result),
            Some(WillError::BadAmount as u32),
            "field {field}"
        );
    }
}

#[test]
fn init_rejects_funding_account_wrong_mint() {
    let mut h = Harness::new();
    let args = init_args(&h, FEE_BPS);
    let authority = copy(&h.upgrade_authority);
    let funding = [h.funding, h.other_mint_funding];
    let result = initialize(&mut h, &authority, PROGRAM_DATA, &args, &funding);
    assert_eq!(
        custom_error(&result),
        Some(WillError::FundingNotAllowed as u32)
    );
}

#[test]
fn init_requires_one_to_four_funding_accounts() {
    let mut h = Harness::new();
    let args = init_args(&h, FEE_BPS);
    let authority = copy(&h.upgrade_authority);
    let result = initialize(&mut h, &authority, PROGRAM_DATA, &args, &[]);
    assert_eq!(
        custom_error(&result),
        Some(WillError::FundingNotAllowed as u32)
    );
}

#[test]
fn update_config_admin_only() {
    let mut h = Harness::new();
    init_default(&mut h).unwrap();
    let mut args = update_args(&h);
    args.operator = h.stranger.pubkey();
    args.fee_bps.set(250);
    let second_funding = h.create_token_account(h.mint, h.altitude.pubkey());

    for outsider in [
        copy(&h.stranger),
        copy(&h.operator),
        copy(&h.upgrade_authority),
    ] {
        let funding = [h.funding];
        let result = update(&mut h, &outsider, &args, &funding);
        assert_eq!(custom_error(&result), Some(WillError::NotAdmin as u32));
    }
    let admin = copy(&h.admin);
    let funding = [h.funding, second_funding];
    update(&mut h, &admin, &args, &funding).unwrap();
    let config = h.config();
    assert_eq!(
        (config.operator, config.fee_bps.get()),
        (h.stranger.pubkey(), 250)
    );
    assert_eq!(
        (config.funding_count, config.funding[1]),
        (2, second_funding)
    );
    assert_eq!(config.mint, h.mint, "the mint is immutable");
}

#[test]
fn update_config_validates_like_initialize() {
    let mut h = Harness::new();
    init_default(&mut h).unwrap();
    let admin = copy(&h.admin);
    let mut args = update_args(&h);
    args.fee_bps.set(1_001);
    let funding = [h.funding];
    assert_eq!(
        custom_error(&update(&mut h, &admin, &args, &funding)),
        Some(WillError::BadAmount as u32)
    );
    let args = update_args(&h);
    let funding = [h.other_mint_funding];
    assert_eq!(
        custom_error(&update(&mut h, &admin, &args, &funding)),
        Some(WillError::FundingNotAllowed as u32)
    );
}

#[test]
fn update_config_sets_and_clears_pause() {
    let mut h = Harness::new();
    init_default(&mut h).unwrap();
    let admin = copy(&h.admin);
    let funding = [h.funding];
    let mut args = update_args(&h);
    args.paused = 1;
    update(&mut h, &admin, &args, &funding).unwrap();
    assert_eq!(h.config().paused, 1);
    args.paused = 0;
    update(&mut h, &admin, &args, &funding).unwrap();
    assert_eq!(h.config().paused, 0);
}
