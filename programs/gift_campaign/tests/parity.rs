//! Differential test: the same transactions against the Anchor build and the
//! Pinocchio port (`programs/gift_campaign_pinocchio`) must produce the same
//! success/failure, the same custom error codes, byte-identical accounts and
//! byte-identical `Program data:` events.
//!
//! Needs both binaries: `anchor build` and
//! `cargo build-sbf --manifest-path programs/gift_campaign_pinocchio/Cargo.toml`.

use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, program_pack::Pack, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token,
    gift_campaign::{
        accounts as acc,
        constants::{CAMPAIGN_SEED, CONFIG_SEED, MANDATE_SEED, VAULT_SEED},
        instruction as ix,
        mandate::quote_terms_hash,
        state::{Campaign, Config, Mandate},
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_system_interface::instruction as system_instruction,
    solana_transaction::versioned::VersionedTransaction,
    std::{collections::BTreeMap, path::PathBuf},
};

const ID: Pubkey = gift_campaign::ID;
const TOKEN: Pubkey = anchor_spl::token::ID;
const INITIAL_TOKENS: u64 = 1_000_000_000;
const BUDGET: u64 = 100_000_000;
const FEE_BPS: u16 = 500;
const SETTLEMENT: u64 = 31_640_000;
const CHARGE: u64 = 2_490;
/// Campaign nonces the random walk spreads over (0..=3 primed, the rest fresh).
const NONCES: u64 = 6;

fn program(env: &str, default: &str) -> Vec<u8> {
    let path = std::env::var_os(env).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/deploy")
            .join(default)
    });
    std::fs::read(&path)
        .unwrap_or_else(|_| panic!("missing {}: build both programs first", path.display()))
}

fn key(n: u8) -> Keypair {
    Keypair::new_from_array([n; 32])
}

fn copy(k: &Keypair) -> Keypair {
    Keypair::try_from(k.to_bytes().as_slice()).unwrap()
}

#[derive(Debug, PartialEq)]
enum Outcome {
    Ok,
    /// Custom program error code, if any.
    Err(Option<u32>),
}

/// Two SVMs driven in lockstep.
struct Twin {
    anchor: LiteSVM,
    pinocchio: LiteSVM,
    tracked: Vec<Pubkey>,
    compute: BTreeMap<&'static str, (u64, u64, u32)>,
}

impl Twin {
    fn new() -> Self {
        let mut twin = Self {
            anchor: LiteSVM::new(),
            pinocchio: LiteSVM::new(),
            tracked: Vec::new(),
            compute: BTreeMap::new(),
        };
        twin.anchor
            .add_program(ID, &program("GIFT_CAMPAIGN_SO", "gift_campaign.so"))
            .unwrap();
        twin.pinocchio
            .add_program(
                ID,
                &program("GIFT_CAMPAIGN_PINOCCHIO_SO", "gift_campaign_pinocchio.so"),
            )
            .unwrap();
        twin
    }

    fn both(&mut self, mut f: impl FnMut(&mut LiteSVM)) {
        f(&mut self.anchor);
        f(&mut self.pinocchio);
    }

    fn track(&mut self, keys: &[Pubkey]) {
        for key in keys {
            if !self.tracked.contains(key) {
                self.tracked.push(*key);
            }
        }
    }

    fn set_clock(&mut self, now: i64) {
        self.both(|svm| {
            let mut clock = svm.get_sysvar::<Clock>();
            clock.unix_timestamp = now;
            svm.set_sysvar(&clock);
        });
    }

    /// Setup transactions that do not involve the programs under test.
    fn setup(&mut self, instructions: &[Instruction], payer: &Keypair, signers: &[&Keypair]) {
        self.both(|svm| {
            send(svm, payer, instructions, signers).unwrap();
        });
    }

    /// Sends to both programs and asserts identical observable behaviour.
    fn send(&mut self, label: &'static str, instruction: Instruction, payer: &Keypair) -> Outcome {
        let anchor = send(
            &mut self.anchor,
            payer,
            std::slice::from_ref(&instruction),
            &[],
        );
        let pinocchio = send(&mut self.pinocchio, payer, &[instruction], &[]);
        self.both(|svm| svm.expire_blockhash());
        let outcome = match (&anchor, &pinocchio) {
            (Ok(a), Ok(p)) => {
                assert_eq!(events(&a.logs), events(&p.logs), "{label}: events differ");
                let entry = self.compute.entry(label).or_default();
                entry.0 += a.compute_units_consumed;
                entry.1 += p.compute_units_consumed;
                entry.2 += 1;
                Outcome::Ok
            }
            (Err(a), Err(p)) => {
                let (a, p) = (custom(&a.err), custom(&p.err));
                // Anchor framework errors (< 6000) map to built-in ProgramErrors in the
                // port; program errors must match exactly.
                if a.is_some_and(|code| code >= 6000) || p.is_some_and(|code| code >= 6000) {
                    assert_eq!(a, p, "{label}: custom error codes differ");
                }
                Outcome::Err(a)
            }
            _ => panic!(
                "{label}: outcomes diverge\n anchor: {:?}\n pinocchio: {:?}",
                anchor
                    .as_ref()
                    .map(|m| &m.logs)
                    .map_err(|e| (&e.err, &e.meta.logs)),
                pinocchio
                    .as_ref()
                    .map(|m| &m.logs)
                    .map_err(|e| (&e.err, &e.meta.logs)),
            ),
        };
        self.assert_same_state(label);
        outcome
    }

    fn assert_same_state(&self, label: &str) {
        for key in &self.tracked {
            assert_eq!(
                self.anchor.get_account(key),
                self.pinocchio.get_account(key),
                "{label}: account {key} differs"
            );
        }
    }

    fn read<T: AccountDeserialize>(&self, key: &Pubkey) -> Option<T> {
        let account = self.anchor.get_account(key)?;
        T::try_deserialize(&mut account.data.as_slice()).ok()
    }
}

fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> TransactionResult {
    let message =
        Message::new_with_blockhash(instructions, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut all: Vec<&dyn Signer> = vec![payer];
    all.extend(signers.iter().map(|k| *k as &dyn Signer));
    svm.send_transaction(
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all).unwrap(),
    )
}

fn events(logs: &[String]) -> Vec<&String> {
    logs.iter()
        .filter(|line| line.starts_with("Program data: "))
        .collect()
}

fn custom(error: &impl std::fmt::Debug) -> Option<u32> {
    let text = format!("{error:?}");
    let start = text.find("Custom(")? + "Custom(".len();
    text[start..].split(')').next()?.parse().ok()
}

/// Parties, token accounts and the initialized config, identical in both SVMs.
struct World {
    twin: Twin,
    payer: Keypair,
    sender: Keypair,
    research: Keypair,
    delivery: Keypair,
    executor: Keypair,
    treasury: Keypair,
    mint: Pubkey,
    sender_token: Pubkey,
    treasury_token: Pubkey,
    operator_token: Pubkey,
    attacker_token: Pubkey,
    other_mint: Pubkey,
    other_mint_sender_token: Pubkey,
    config: Pubkey,
    now: i64,
}

impl World {
    fn new() -> Self {
        let mut twin = Twin::new();
        let [payer, sender, research, delivery, executor, treasury] = [1, 2, 3, 4, 5, 6].map(key);
        twin.both(|svm| {
            for wallet in [&payer, &sender, &research, &delivery, &executor, &treasury] {
                svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
            }
        });
        let mint = create_mint(&mut twin, &payer, 20);
        let other_mint = create_mint(&mut twin, &payer, 21);
        let sender_token = create_token_account(&mut twin, &payer, 22, &mint, &sender.pubkey());
        let treasury_token = create_token_account(&mut twin, &payer, 23, &mint, &treasury.pubkey());
        let operator_token = create_token_account(&mut twin, &payer, 24, &mint, &delivery.pubkey());
        let attacker_token = create_token_account(&mut twin, &payer, 25, &mint, &executor.pubkey());
        let other_mint_sender_token =
            create_token_account(&mut twin, &payer, 26, &other_mint, &sender.pubkey());
        for (target, mint) in [(sender_token, mint), (other_mint_sender_token, other_mint)] {
            let mint_to = spl_token::instruction::mint_to(
                &TOKEN,
                &mint,
                &target,
                &payer.pubkey(),
                &[],
                INITIAL_TOKENS,
            )
            .unwrap();
            twin.setup(&[mint_to], &payer, &[]);
        }
        let config = Pubkey::find_program_address(&[CONFIG_SEED], &ID).0;
        twin.track(&[
            config,
            sender_token,
            treasury_token,
            operator_token,
            attacker_token,
            other_mint_sender_token,
            payer.pubkey(),
            sender.pubkey(),
            research.pubkey(),
            delivery.pubkey(),
            executor.pubkey(),
        ]);
        let mut world = Self {
            twin,
            payer,
            sender,
            research,
            delivery,
            executor,
            treasury,
            mint,
            sender_token,
            treasury_token,
            operator_token,
            attacker_token,
            other_mint,
            other_mint_sender_token,
            config,
            now: 1_000,
        };
        world.twin.set_clock(world.now);
        world
    }

    fn initialize(&mut self, fee_bps: u16) -> Outcome {
        self.initialize_with_treasury(fee_bps, self.treasury.pubkey())
    }

    fn initialize_with_treasury(&mut self, fee_bps: u16, treasury: Pubkey) -> Outcome {
        let instruction = Instruction::new_with_bytes(
            ID,
            &ix::Initialize { fee_bps }.data(),
            acc::Initialize {
                config: self.config,
                authority: self.payer.pubkey(),
                treasury,
                research_oracle: self.research.pubkey(),
                delivery_oracle: self.delivery.pubkey(),
                allowed_mint: self.mint,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let payer = copy(&self.payer);
        self.twin.send("initialize", instruction, &payer)
    }

    fn addresses(&mut self, nonce: u64) -> (Pubkey, Pubkey, Pubkey) {
        let campaign = Pubkey::find_program_address(
            &[
                CAMPAIGN_SEED,
                self.sender.pubkey().as_ref(),
                &nonce.to_le_bytes(),
            ],
            &ID,
        )
        .0;
        let vault = Pubkey::find_program_address(&[VAULT_SEED, campaign.as_ref()], &ID).0;
        let mandate = Pubkey::find_program_address(&[MANDATE_SEED, campaign.as_ref()], &ID).0;
        self.twin.track(&[campaign, vault, mandate]);
        (campaign, vault, mandate)
    }

    fn quote(&self) -> ix::SubmitQuote {
        ix::SubmitQuote {
            quote_version: 1,
            job_kind: 0,
            adapter: 0,
            spec_hash: [44; 32],
            quote_hash: [55; 32],
            merchant_hash: [66; 32],
            currency: *b"PLN",
            currency_exponent: 2,
            charge_currency: *b"EUR",
            charge_currency_exponent: 2,
            item_subtotal_minor: 2_050,
            small_order_fee_minor: 499,
            service_fee_minor: 390,
            delivery_fee_minor: 225,
            tip_minor: 0,
            other_fees_minor: 0,
            landed_total_minor: 3_164,
            max_total_minor: 8_000,
            settlement_amount: SETTLEMENT,
            quoted_charge_amount_minor: CHARGE,
            settlement_units_per_charge_unit_micros: 1_270_683,
            quote_captured_at: self.now,
            quote_expires_at: self.now + 4_000,
        }
    }

    fn mandate_terms(&self) -> ix::AuthorizeMandate {
        ix::AuthorizeMandate {
            executor: self.executor.pubkey(),
            merchant_hash: [66; 32],
            spec_hash: [44; 32],
            recipient_hash: [133; 32],
            charge_currency: *b"EUR",
            charge_currency_exponent: 2,
            max_charge_amount_minor: CHARGE,
            max_escrow_debit: SETTLEMENT + SETTLEMENT * u64::from(FEE_BPS) / 10_000,
            expires_at: self.now + 3_000,
        }
    }

    fn terms_hash(&self, campaign: Pubkey, mandate: Pubkey) -> [u8; 32] {
        match (
            self.twin.read::<Campaign>(&campaign),
            self.twin.read::<Mandate>(&mandate),
            self.twin.read::<Config>(&self.config),
        ) {
            (Some(c), Some(m), Some(config)) => {
                quote_terms_hash(campaign, mandate, &c, &m, &config)
            }
            _ => [9; 32],
        }
    }
}

fn create_mint(twin: &mut Twin, payer: &Keypair, seed: u8) -> Pubkey {
    let mint = key(seed);
    let space = spl_token::state::Mint::LEN;
    let lamports = twin.anchor.minimum_balance_for_rent_exemption(space);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        lamports,
        space as u64,
        &TOKEN,
    );
    let init =
        spl_token::instruction::initialize_mint2(&TOKEN, &mint.pubkey(), &payer.pubkey(), None, 6)
            .unwrap();
    twin.setup(&[create, init], payer, &[&mint]);
    mint.pubkey()
}

fn create_token_account(
    twin: &mut Twin,
    payer: &Keypair,
    seed: u8,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Pubkey {
    let token = key(seed);
    let space = spl_token::state::Account::LEN;
    let lamports = twin.anchor.minimum_balance_for_rent_exemption(space);
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &token.pubkey(),
        lamports,
        space as u64,
        &TOKEN,
    );
    let init =
        spl_token::instruction::initialize_account3(&TOKEN, &token.pubkey(), mint, owner).unwrap();
    twin.setup(&[create, init], payer, &[&token]);
    token.pubkey()
}

/// Every instruction, with account/argument choices drawn from `pick`.
/// `pick(n)` returns a value in `0..n`; choice 0 is always the valid one.
fn step(
    world: &mut World,
    action: u64,
    mut pick: impl FnMut(u64) -> u64,
) -> (&'static str, Outcome) {
    let nonce = pick(NONCES);
    let (campaign, vault, mandate) = world.addresses(nonce);
    let signers = [
        copy(&world.sender),
        copy(&world.research),
        copy(&world.delivery),
        copy(&world.executor),
    ];
    let hashes = [[7u8; 32], [0; 32], [8; 32]];
    let signer = |preferred: usize, pick: &mut dyn FnMut(u64) -> u64| {
        if pick(5) == 4 {
            copy(&signers[pick(4) as usize])
        } else {
            copy(&signers[preferred])
        }
    };
    let token_choice =
        |pick: &mut dyn FnMut(u64) -> u64, valid: Pubkey, world: &World| match pick(8) {
            5 => world.attacker_token,
            6 => world.other_mint_sender_token,
            7 => world.treasury_token,
            _ => valid,
        };
    let other_vault = world.addresses((nonce + 1) % NONCES).1;
    let vault_choice = if pick(10) == 9 { other_vault } else { vault };

    let (label, instruction, payer): (&'static str, Instruction, Keypair) = match action {
        0 => {
            let budget = [BUDGET, 0, 1, INITIAL_TOKENS * 2][pick(4) as usize];
            let expires_at = world.now + [10_000, 0, -1, 200][pick(4) as usize];
            let (sender_token, mint) = if pick(10) == 9 {
                (world.other_mint_sender_token, world.other_mint)
            } else {
                (world.sender_token, world.mint)
            };
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::CreateCampaign {
                    nonce,
                    budget,
                    expires_at,
                }
                .data(),
                acc::CreateCampaign {
                    config: world.config,
                    campaign,
                    vault,
                    sender: world.sender.pubkey(),
                    sender_token,
                    mint,
                    token_program: TOKEN,
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            );
            ("create_campaign", instruction, copy(&world.sender))
        }
        1 => {
            let s = signer(1, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::SubmitResearch {
                    research_hash: hashes[pick(3) as usize],
                }
                .data(),
                acc::SubmitResearch {
                    config: world.config,
                    campaign,
                    research_oracle: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("submit_research", instruction, s)
        }
        2 => {
            let s = signer(0, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::ApproveGift {
                    gift_hash: hashes[pick(3) as usize],
                }
                .data(),
                acc::ApproveGift {
                    campaign,
                    sender: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("approve_gift", instruction, s)
        }
        3 => {
            let s = signer(0, &mut pick);
            let mut terms = world.mandate_terms();
            match pick(12) {
                1 => terms.merchant_hash = [0; 32],
                2 => terms.executor = Pubkey::default(),
                3 => terms.charge_currency = *b"eur",
                4 => terms.charge_currency_exponent = 5,
                5 => terms.max_escrow_debit -= 1,
                6 => terms.max_charge_amount_minor -= 1,
                7 => terms.max_escrow_debit = BUDGET + 1,
                8 => terms.expires_at = world.now,
                9 => terms.spec_hash = [45; 32],
                _ => {}
            }
            let instruction = Instruction::new_with_bytes(
                ID,
                &terms.data(),
                acc::AuthorizeMandate {
                    campaign,
                    mandate,
                    sender: s.pubkey(),
                    system_program: system_program::ID,
                }
                .to_account_metas(None),
            );
            ("authorize_mandate", instruction, s)
        }
        4 => {
            let s = signer(0, &mut pick);
            let mandate = if pick(10) == 9 {
                world.addresses((nonce + 1) % NONCES).2
            } else {
                mandate
            };
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::RevokeMandate {}.data(),
                acc::RevokeMandate {
                    campaign,
                    mandate,
                    sender: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("revoke_mandate", instruction, s)
        }
        5 => {
            let s = signer(3, &mut pick);
            let terms_hash = match pick(4) {
                1 => [1; 32],
                2 => [0; 32],
                _ => world.terms_hash(campaign, mandate),
            };
            let mandate_account = if pick(10) == 9 {
                world.addresses((nonce + 1) % NONCES).2
            } else {
                mandate
            };
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::ApproveQuoteWithMandate {
                    quote_version: [1, 1, 1, 2][pick(4) as usize],
                    terms_hash,
                }
                .data(),
                acc::ApproveQuoteWithMandate {
                    config: world.config,
                    campaign,
                    mandate: mandate_account,
                    executor: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("approve_quote_with_mandate", instruction, s)
        }
        6 => {
            let s = signer(3, &mut pick);
            let terms_hash = if pick(4) == 1 {
                [1; 32]
            } else {
                world.terms_hash(campaign, mandate)
            };
            let mandate = if pick(10) == 9 {
                world.addresses((nonce + 1) % NONCES).2
            } else {
                mandate
            };
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::RecordPaymentAttemptWithMandate {
                    terms_hash,
                    payment_attempt_hash: hashes[pick(3) as usize],
                }
                .data(),
                acc::RecordPaymentAttemptWithMandate {
                    config: world.config,
                    campaign,
                    mandate,
                    executor: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("record_payment_attempt_with_mandate", instruction, s)
        }
        7 => {
            let s = signer(1, &mut pick);
            let mut q = world.quote();
            match pick(20) {
                1 => q.landed_total_minor += 1,
                2 => q.quote_version = 0,
                3 => q.job_kind = 4,
                4 => q.adapter = 4,
                5 => q.spec_hash = [0; 32],
                6 => q.currency = *b"pl1",
                7 => q.charge_currency_exponent = 5,
                8 => q.tip_minor = u64::MAX,
                9 => q.max_total_minor = 3_000,
                10 => q.settlement_amount = 0,
                11 => q.quote_captured_at = q.quote_expires_at + 1,
                12 => q.quote_expires_at = world.now,
                13 => q.quote_expires_at = world.now + 1_000_000,
                14 => q.settlement_amount = u64::MAX,
                15 => q.settlement_amount = BUDGET,
                16 => q.merchant_hash = [67; 32],
                17 => q.settlement_units_per_charge_unit_micros = 0,
                18 => q.quoted_charge_amount_minor = CHARGE + 1,
                _ => {}
            }
            let instruction = Instruction::new_with_bytes(
                ID,
                &q.data(),
                acc::SubmitQuote {
                    config: world.config,
                    campaign,
                    research_oracle: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("submit_quote", instruction, s)
        }
        8 => {
            let s = signer(0, &mut pick);
            let (quote_version, quote_hash) = match pick(5) {
                1 => (2, [55; 32]),
                2 => (1, [56; 32]),
                _ => (1, [55; 32]),
            };
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::ApproveQuote {
                    quote_version,
                    quote_hash,
                }
                .data(),
                acc::ApproveQuote {
                    campaign,
                    sender: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("approve_quote", instruction, s)
        }
        9 => {
            let s = signer(2, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::RecordPaymentAttempt {
                    quote_version: [1, 1, 1, 0][pick(4) as usize],
                    quote_hash: if pick(5) == 4 { [0; 32] } else { [55; 32] },
                    payment_attempt_hash: hashes[pick(3) as usize],
                }
                .data(),
                acc::RecordPaymentAttempt {
                    config: world.config,
                    campaign,
                    fulfillment_oracle: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("record_payment_attempt", instruction, s)
        }
        10 => {
            let s = signer(2, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::RecordPaymentAuth {
                    payment_auth_hash: hashes[pick(3) as usize],
                    currency: if pick(6) == 5 { *b"PLN" } else { *b"EUR" },
                    authenticated_amount_minor: [CHARGE, CHARGE, CHARGE + 1][pick(3) as usize],
                }
                .data(),
                acc::RecordPaymentAuth {
                    config: world.config,
                    campaign,
                    fulfillment_oracle: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("record_payment_auth", instruction, s)
        }
        11 => {
            let s = signer(2, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::RecordPurchase {
                    purchase_hash: hashes[pick(3) as usize],
                    order_id_hash: hashes[pick(3) as usize],
                    currency: if pick(6) == 5 { *b"PLN" } else { *b"EUR" },
                    charged_amount_minor: [CHARGE, CHARGE, CHARGE - 1][pick(3) as usize],
                }
                .data(),
                acc::RecordPurchase {
                    config: world.config,
                    campaign,
                    fulfillment_oracle: s.pubkey(),
                }
                .to_account_metas(None),
            );
            ("record_purchase", instruction, s)
        }
        12 => {
            let s = signer(2, &mut pick);
            let operator_token = if pick(10) == 9 {
                world.treasury_token
            } else {
                world.operator_token
            };
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::SettleFulfillment {
                    pod_hash: hashes[pick(3) as usize],
                    fulfillment_hash: hashes[pick(3) as usize],
                }
                .data(),
                acc::SettleFulfillment {
                    config: world.config,
                    campaign,
                    vault: vault_choice,
                    sender_token: token_choice(&mut pick, world.sender_token, world),
                    treasury_token: world.treasury_token,
                    operator_token,
                    fulfillment_oracle: s.pubkey(),
                    token_program: TOKEN,
                }
                .to_account_metas(None),
            );
            ("settle_fulfillment", instruction, s)
        }
        13 => {
            let s = signer(2, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::ConfirmDelivery {
                    pod_hash: hashes[pick(3) as usize],
                }
                .data(),
                acc::ConfirmDelivery {
                    config: world.config,
                    campaign,
                    vault: vault_choice,
                    sender_token: token_choice(&mut pick, world.sender_token, world),
                    treasury_token: token_choice(&mut pick, world.treasury_token, world),
                    delivery_oracle: s.pubkey(),
                    token_program: TOKEN,
                }
                .to_account_metas(None),
            );
            ("confirm_delivery", instruction, s)
        }
        _ => {
            let s = signer(if pick(3) == 2 { 2 } else { 0 }, &mut pick);
            let instruction = Instruction::new_with_bytes(
                ID,
                &ix::Cancel {}.data(),
                acc::Cancel {
                    config: world.config,
                    campaign,
                    vault: vault_choice,
                    sender_token: token_choice(&mut pick, world.sender_token, world),
                    canceller: s.pubkey(),
                    token_program: TOKEN,
                }
                .to_account_metas(None),
            );
            ("cancel", instruction, s)
        }
    };
    let outcome = world.twin.send(label, instruction, &payer);
    (label, outcome)
}

/// Runs `(action, nonce)` steps taking the valid choice for every other pick.
fn scripted(w: &mut World, script: &[(u64, u64)]) {
    for &(action, nonce) in script {
        let mut first = true;
        let (label, outcome) = step(w, action, |_| {
            let choice = if first { nonce } else { 0 };
            first = false;
            choice
        });
        assert_eq!(outcome, Outcome::Ok, "{label} (nonce {nonce})");
    }
}

#[test]
fn every_instruction_matches_on_the_happy_paths() {
    let mut w = World::new();
    assert_eq!(w.initialize(FEE_BPS), Outcome::Ok);
    // Nonce 0: legacy research -> approval -> delivery. Nonce 1: quote path.
    // Nonce 2: mandate path. `pick` always returns the valid choice.
    let script: &[(u64, u64)] = &[
        (0, 0),
        (1, 0),
        (2, 0),
        (13, 0),
        (0, 1),
        (7, 1),
        (8, 1),
        (9, 1),
        (10, 1),
        (11, 1),
        (12, 1),
        (0, 2),
        (7, 2),
        (3, 2),
        (5, 2),
        (6, 2),
        (10, 2),
        (11, 2),
        (12, 2),
    ];
    scripted(&mut w, script);
    // Mandate revocation, then sender cancellation, on a fresh world.
    let compute = std::mem::take(&mut w.twin.compute);
    let mut w = World::new();
    w.twin.compute = compute;
    assert_eq!(w.initialize(FEE_BPS), Outcome::Ok);
    for (action, expected) in [
        (0, Outcome::Ok),
        (3, Outcome::Ok),
        (4, Outcome::Ok),
        (14, Outcome::Ok),
    ] {
        let (label, outcome) = step(&mut w, action, |_| 0);
        assert_eq!(outcome, expected, "{label}");
    }
    print_compute(&w.twin);
}

#[test]
fn initialize_rejects_high_fee_identically() {
    let mut w = World::new();
    assert_eq!(w.initialize(1_001), Outcome::Err(Some(6000)));
    assert_eq!(w.initialize(1_000), Outcome::Ok);
    assert!(matches!(w.initialize(1_000), Outcome::Err(_)));
}

/// Seeded random walks over all instructions, signers, account substitutions,
/// argument mutations and clock movements.
#[test]
fn random_instruction_sequences_match() {
    let seeds: u64 = std::env::var("PARITY_SEEDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(24);
    let mut successes: BTreeMap<&'static str, u32> = BTreeMap::new();
    let mut total = 0;
    for seed in 1..=seeds {
        let mut w = World::new();
        assert_eq!(w.initialize(FEE_BPS), Outcome::Ok);
        // Start from deep states: legacy Approved (nonce 0), quote Approved
        // (nonce 1), mandate authorized on a Quoted campaign (nonce 2) and a
        // mandate-approved quote awaiting its payment attempt (nonce 3).
        scripted(
            &mut w,
            &[
                (0, 0),
                (1, 0),
                (2, 0),
                (0, 1),
                (7, 1),
                (8, 1),
                (0, 2),
                (7, 2),
                (3, 2),
                (0, 3),
                (7, 3),
                (3, 3),
                (5, 3),
            ],
        );
        let mut state = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut rand = move |n: u64| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state % n
        };
        for _ in 0..250 {
            if rand(16) == 0 {
                w.now += [1, 60, 600, 3_000][rand(4) as usize];
                w.twin.set_clock(w.now);
            }
            let action = rand(15);
            // Choice 0 is always the valid option; favour it so walks reach the
            // later lifecycle states while still exploring every bad input.
            let mut first = true;
            let (label, outcome) = step(&mut w, action, |n| {
                if std::mem::take(&mut first) || rand(10) >= 7 {
                    rand(n) // the nonce, or an exploratory choice
                } else {
                    0
                }
            });
            total += 1;
            if outcome == Outcome::Ok {
                *successes.entry(label).or_default() += 1;
            }
        }
    }
    println!("{total} steps; successes per instruction: {successes:#?}");
    // Guard against a walk that only ever exercises failures.
    for label in [
        "create_campaign",
        "submit_research",
        "approve_gift",
        "authorize_mandate",
        "revoke_mandate",
        "approve_quote_with_mandate",
        "record_payment_attempt_with_mandate",
        "submit_quote",
        "approve_quote",
        "record_payment_attempt",
        "record_payment_auth",
        "record_purchase",
        "settle_fulfillment",
        "confirm_delivery",
        "cancel",
    ] {
        assert!(
            successes.get(label).copied().unwrap_or(0) > 0,
            "{label} never succeeded"
        );
    }
}

fn print_compute(twin: &Twin) {
    println!(
        "{:<38} {:>9} {:>9}",
        "instruction (avg CU)", "anchor", "pinocchio"
    );
    for (label, (anchor, pinocchio, n)) in &twin.compute {
        println!(
            "{label:<38} {:>9} {:>9}",
            anchor / u64::from(*n),
            pinocchio / u64::from(*n)
        );
    }
}

fn meta(instruction: &mut Instruction, index: usize, pubkey: Pubkey, is_signer: bool) {
    instruction.accounts[index].pubkey = pubkey;
    instruction.accounts[index].is_signer = is_signer;
}

fn raw(w: &mut World, label: &'static str, instruction: Instruction, payer: &Keypair) -> Outcome {
    w.twin.send(label, instruction, payer)
}

fn fund(w: &mut World, target: Pubkey, lamports: u64) {
    let payer = copy(&w.payer);
    w.twin.setup(
        &[system_instruction::transfer(
            &payer.pubkey(),
            &target,
            lamports,
        )],
        &payer,
        &[],
    );
    w.twin.track(&[target]);
}

/// Places an arbitrary account in both SVMs (something only a test can do) to
/// probe the owner, discriminator, PDA and type checks.
fn forge(w: &mut World, address: Pubkey, owner: Pubkey, data: Vec<u8>) {
    let account = solana_account::Account {
        lamports: 10_000_000,
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    };
    w.twin
        .both(|svm| svm.set_account(address, account.clone()).unwrap());
    w.twin.track(&[address]);
}

#[test]
fn prefunded_pdas_initialize_identically() {
    let mut w = World::new();
    let (campaign, vault, mandate) = w.addresses(0);
    // Below, above and exactly zero shortfall versus the rent-exempt minimum.
    let config = w.config;
    fund(&mut w, config, 1);
    fund(&mut w, campaign, 1_000_000_000);
    fund(&mut w, vault, 890_880);
    fund(&mut w, mandate, 5);
    assert_eq!(w.initialize(FEE_BPS), Outcome::Ok);
    scripted(&mut w, &[(0, 0), (3, 0), (4, 0), (14, 0)]);
}

#[test]
fn duplicate_and_surplus_accounts_are_handled_identically() {
    let mut w = World::new();
    // One key in three account slots exercises duplicate-marker resolution.
    let oracle = w.research.pubkey();
    let mut instruction = Instruction::new_with_bytes(
        ID,
        &ix::Initialize { fee_bps: FEE_BPS }.data(),
        acc::Initialize {
            config: w.config,
            authority: w.payer.pubkey(),
            treasury: oracle,
            research_oracle: oracle,
            delivery_oracle: oracle,
            allowed_mint: w.mint,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    let payer = copy(&w.payer);
    assert_eq!(
        raw(
            &mut w,
            "initialize (duplicates)",
            instruction.clone(),
            &payer
        ),
        Outcome::Ok
    );

    // More accounts than the port parses (8): the surplus is skipped and the
    // instruction data still found, as Anchor ignores remaining accounts.
    scripted(&mut w, &[(0, 0)]);
    let (campaign, _, _) = w.addresses(0);
    instruction = Instruction::new_with_bytes(
        ID,
        &ix::SubmitResearch {
            research_hash: [7; 32],
        }
        .data(),
        acc::SubmitResearch {
            config: w.config,
            campaign,
            research_oracle: oracle,
        }
        .to_account_metas(None),
    );
    for n in 0..12u8 {
        let extra = if n % 3 == 0 {
            campaign
        } else {
            key(100 + n).pubkey()
        };
        instruction
            .accounts
            .push(anchor_lang::prelude::AccountMeta::new_readonly(
                extra, false,
            ));
    }
    let research = copy(&w.research);
    assert_eq!(
        raw(
            &mut w,
            "submit_research (surplus accounts)",
            instruction,
            &research
        ),
        Outcome::Ok
    );
}

#[test]
fn malformed_and_forged_inputs_are_rejected_identically() {
    let mut w = World::new();
    assert_eq!(w.initialize(FEE_BPS), Outcome::Ok);
    scripted(&mut w, &[(0, 0), (0, 1), (7, 1), (3, 1)]);
    let (campaign, vault, _) = w.addresses(0);
    let (campaign_b, vault_b, mandate_b) = w.addresses(1);
    let sender = copy(&w.sender);
    let research = copy(&w.research);
    let executor = copy(&w.executor);
    let research_ix = |w: &World, config: Pubkey, campaign: Pubkey| {
        Instruction::new_with_bytes(
            ID,
            &ix::SubmitResearch {
                research_hash: [7; 32],
            }
            .data(),
            acc::SubmitResearch {
                config,
                campaign,
                research_oracle: w.research.pubkey(),
            }
            .to_account_metas(None),
        )
    };
    let cancel_ix = |w: &World,
                     campaign: Pubkey,
                     vault: Pubkey,
                     sender_token: Pubkey,
                     token_program: Pubkey| {
        Instruction::new_with_bytes(
            ID,
            &ix::Cancel {}.data(),
            acc::Cancel {
                config: w.config,
                campaign,
                vault,
                sender_token,
                canceller: w.sender.pubkey(),
                token_program,
            }
            .to_account_metas(None),
        )
    };

    // Instruction data and account-count framing.
    let mut short = research_ix(&w, w.config, campaign);
    short.data.truncate(20);
    assert!(matches!(
        raw(&mut w, "short args", short, &research),
        Outcome::Err(_)
    ));
    let mut unknown = research_ix(&w, w.config, campaign);
    unknown.data[0] ^= 1;
    assert!(matches!(
        raw(&mut w, "unknown discriminator", unknown, &research),
        Outcome::Err(_)
    ));
    let mut tag_only = research_ix(&w, w.config, campaign);
    tag_only.data.truncate(7);
    assert!(matches!(
        raw(&mut w, "truncated discriminator", tag_only, &research),
        Outcome::Err(_)
    ));
    let mut few = research_ix(&w, w.config, campaign);
    few.accounts.truncate(2);
    assert!(matches!(
        raw(&mut w, "too few accounts", few, &research),
        Outcome::Err(_)
    ));

    // Signer flags.
    let mut unsigned = Instruction::new_with_bytes(
        ID,
        &ix::ApproveGift { gift_hash: [7; 32] }.data(),
        acc::ApproveGift {
            campaign,
            sender: w.sender.pubkey(),
        }
        .to_account_metas(None),
    );
    meta(&mut unsigned, 1, w.sender.pubkey(), false);
    assert!(matches!(
        raw(&mut w, "unsigned sender", unsigned, &executor),
        Outcome::Err(_)
    ));

    // Program ids.
    let fake_token = cancel_ix(&w, campaign, vault, w.sender_token, system_program::ID);
    assert!(matches!(
        raw(&mut w, "wrong token program", fake_token, &sender),
        Outcome::Err(_)
    ));

    // Type confusion between program-owned accounts.
    let confused = research_ix(&w, campaign, campaign);
    assert!(matches!(
        raw(&mut w, "campaign as config", confused, &research),
        Outcome::Err(_)
    ));
    let confused = research_ix(&w, w.config, mandate_b);
    assert!(matches!(
        raw(&mut w, "mandate as campaign", confused, &research),
        Outcome::Err(_)
    ));
    let confused = cancel_ix(&w, campaign, campaign_b, w.sender_token, TOKEN);
    assert!(matches!(
        raw(&mut w, "campaign as vault", confused, &sender),
        Outcome::Err(_)
    ));

    // Cross-campaign substitution.
    let crossed = cancel_ix(&w, campaign, vault_b, w.sender_token, TOKEN);
    assert!(matches!(
        raw(&mut w, "other campaign's vault", crossed, &sender),
        Outcome::Err(_)
    ));

    // Forged program-owned config at a non-PDA address naming the executor as oracle.
    let mut config_data = w.twin.anchor.get_account(&w.config).unwrap().data;
    config_data[72..104].copy_from_slice(w.executor.pubkey().as_ref());
    let fake_config = key(90).pubkey();
    forge(&mut w, fake_config, ID, config_data);
    let mut forged = research_ix(&w, fake_config, campaign);
    meta(&mut forged, 2, w.executor.pubkey(), true);
    assert!(matches!(
        raw(&mut w, "forged config", forged, &executor),
        Outcome::Err(_)
    ));

    // Forged copy of a real campaign at a non-PDA address.
    let campaign_data = w.twin.anchor.get_account(&campaign).unwrap().data;
    let fake_campaign = key(91).pubkey();
    forge(&mut w, fake_campaign, ID, campaign_data);
    let forged = cancel_ix(&w, fake_campaign, vault, w.sender_token, TOKEN);
    assert!(matches!(
        raw(&mut w, "forged campaign", forged, &sender),
        Outcome::Err(_)
    ));

    // Token account layout owned by another program.
    let token_data = w.twin.anchor.get_account(&w.sender_token).unwrap().data;
    let fake_token_account = key(92).pubkey();
    forge(&mut w, fake_token_account, key(93).pubkey(), token_data);
    let forged = cancel_ix(&w, campaign, vault, fake_token_account, TOKEN);
    assert!(matches!(
        raw(&mut w, "foreign-owned token account", forged, &sender),
        Outcome::Err(_)
    ));

    // Program-owned account with the right discriminator but truncated data.
    let fake_short = key(94).pubkey();
    let truncated = w.twin.anchor.get_account(&campaign).unwrap().data[..300].to_vec();
    forge(&mut w, fake_short, ID, truncated);
    let forged = research_ix(&w, w.config, fake_short);
    assert!(matches!(
        raw(&mut w, "truncated campaign", forged, &research),
        Outcome::Err(_)
    ));

    // The genuine accounts still work afterwards.
    let genuine = research_ix(&w, w.config, campaign);
    assert_eq!(
        raw(&mut w, "submit_research", genuine, &research),
        Outcome::Ok
    );
}

/// A config whose treasury is a campaign PDA makes that campaign's vault pass
/// the `treasury_token` owner check. Anchor still rejects the vault in a second
/// writable slot (duplicate mutable account); the port must too.
#[test]
fn vault_cannot_double_as_the_treasury_token() {
    for settle in [false, true] {
        let mut w = World::new();
        let (campaign, vault, _) = w.addresses(0);
        assert_eq!(w.initialize_with_treasury(FEE_BPS, campaign), Outcome::Ok);
        let delivery = copy(&w.delivery);
        let instruction = if settle {
            scripted(&mut w, &[(0, 0), (7, 0), (8, 0), (9, 0), (10, 0), (11, 0)]);
            Instruction::new_with_bytes(
                ID,
                &ix::SettleFulfillment {
                    pod_hash: [7; 32],
                    fulfillment_hash: [7; 32],
                }
                .data(),
                acc::SettleFulfillment {
                    config: w.config,
                    campaign,
                    vault,
                    sender_token: w.sender_token,
                    treasury_token: vault,
                    operator_token: w.operator_token,
                    fulfillment_oracle: delivery.pubkey(),
                    token_program: TOKEN,
                }
                .to_account_metas(None),
            )
        } else {
            scripted(&mut w, &[(0, 0), (1, 0), (2, 0)]);
            Instruction::new_with_bytes(
                ID,
                &ix::ConfirmDelivery { pod_hash: [7; 32] }.data(),
                acc::ConfirmDelivery {
                    config: w.config,
                    campaign,
                    vault,
                    sender_token: w.sender_token,
                    treasury_token: vault,
                    delivery_oracle: delivery.pubkey(),
                    token_program: TOKEN,
                }
                .to_account_metas(None),
            )
        };
        let label = if settle {
            "settle (vault as treasury)"
        } else {
            "confirm (vault as treasury)"
        };
        assert!(matches!(
            w.twin.send(label, instruction, &delivery),
            Outcome::Err(_)
        ));
    }
}
