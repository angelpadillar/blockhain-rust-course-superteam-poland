use {
    anchor_lang::{
        prelude::{Clock, Pubkey},
        solana_program::{instruction::Instruction, program_pack::Pack, system_program},
        AccountDeserialize, InstructionData, ToAccountMetas,
    },
    anchor_spl::token::{spl_token, TokenAccount},
    gift_campaign::{
        self,
        constants::{CAMPAIGN_SEED, CONFIG_SEED, VAULT_SEED},
        state::{Campaign, CampaignStatus},
    },
    litesvm::{types::TransactionResult, LiteSVM},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_system_interface::instruction as system_instruction,
    solana_transaction::versioned::VersionedTransaction,
    std::{path::PathBuf, vec},
};

const BUDGET: u64 = 100_000_000;
const INITIAL_TOKENS: u64 = 1_000_000_000;
const FEE_BPS: u16 = 500;
const FUTURE_EXPIRY: i64 = 10_000;
const RESEARCH_HASH: [u8; 32] = [11; 32];
const GIFT_HASH: [u8; 32] = [22; 32];
const POD_HASH: [u8; 32] = [33; 32];
const SPEC_HASH: [u8; 32] = [44; 32];
const QUOTE_HASH: [u8; 32] = [55; 32];
const MERCHANT_HASH: [u8; 32] = [66; 32];
const PAYMENT_ATTEMPT_HASH: [u8; 32] = [77; 32];
const PAYMENT_AUTH_HASH: [u8; 32] = [88; 32];
const PURCHASE_HASH: [u8; 32] = [99; 32];
const ORDER_ID_HASH: [u8; 32] = [111; 32];
const FULFILLMENT_HASH: [u8; 32] = [122; 32];
const QUOTE_TOTAL_MINOR: u64 = 3_164;
const CHARGE_TOTAL_MINOR: u64 = 2_490;
const SETTLEMENT_UNITS_PER_CHARGE_UNIT_MICROS: u64 = 1_270_683;
const SETTLEMENT_AMOUNT: u64 = 31_640_000;

struct Fixture {
    svm: LiteSVM,
    payer: Keypair,
    sender: Keypair,
    research_oracle: Keypair,
    delivery_oracle: Keypair,
    attacker: Keypair,
    mint: Keypair,
    sender_token: Keypair,
    treasury_token: Keypair,
    operator_token: Keypair,
    config: Pubkey,
}

#[path = "cases/mandate.rs"]
mod mandate_cases;

impl Fixture {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        // GIFT_CAMPAIGN_SO runs the same suite against another build, e.g. the
        // wire-compatible Pinocchio port.
        let program_path = std::env::var_os("GIFT_CAMPAIGN_SO")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../target/deploy/gift_campaign.so")
            });
        let program_bytes = std::fs::read(&program_path).unwrap_or_else(|_| {
            panic!(
                "Missing {}. Run `anchor build` before `cargo test`.",
                program_path.display()
            )
        });
        svm.add_program(gift_campaign::id(), &program_bytes)
            .unwrap();

        let payer = Keypair::new();
        let sender = Keypair::new();
        let treasury = Keypair::new();
        let research_oracle = Keypair::new();
        let delivery_oracle = Keypair::new();
        let attacker = Keypair::new();
        for wallet in [
            &payer,
            &sender,
            &treasury,
            &research_oracle,
            &delivery_oracle,
            &attacker,
        ] {
            svm.airdrop(&wallet.pubkey(), 10_000_000_000).unwrap();
        }

        let (mint, sender_token) =
            create_mint_and_token_account(&mut svm, &payer, &sender.pubkey(), INITIAL_TOKENS);
        let treasury_token =
            create_token_account(&mut svm, &payer, &mint.pubkey(), &treasury.pubkey());
        let operator_token =
            create_token_account(&mut svm, &payer, &mint.pubkey(), &delivery_oracle.pubkey());
        let (config, _) = Pubkey::find_program_address(&[CONFIG_SEED], &gift_campaign::id());

        let initialize = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::Initialize { fee_bps: FEE_BPS }.data(),
            gift_campaign::accounts::Initialize {
                config,
                authority: payer.pubkey(),
                treasury: treasury.pubkey(),
                research_oracle: research_oracle.pubkey(),
                delivery_oracle: delivery_oracle.pubkey(),
                allowed_mint: mint.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(&mut svm, &payer, &[initialize], &[]).unwrap();

        Self {
            svm,
            payer,
            sender,
            research_oracle,
            delivery_oracle,
            attacker,
            mint,
            sender_token,
            treasury_token,
            operator_token,
            config,
        }
    }

    fn campaign_addresses(&self, nonce: u64) -> (Pubkey, Pubkey) {
        let (campaign, _) = Pubkey::find_program_address(
            &[
                CAMPAIGN_SEED,
                self.sender.pubkey().as_ref(),
                &nonce.to_le_bytes(),
            ],
            &gift_campaign::id(),
        );
        let (vault, _) =
            Pubkey::find_program_address(&[VAULT_SEED, campaign.as_ref()], &gift_campaign::id());
        (campaign, vault)
    }

    fn create_campaign(&mut self, nonce: u64, expiry: i64) -> (Pubkey, Pubkey) {
        let (campaign, vault) = self.campaign_addresses(nonce);
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::CreateCampaign {
                nonce,
                budget: BUDGET,
                expires_at: expiry,
            }
            .data(),
            gift_campaign::accounts::CreateCampaign {
                config: self.config,
                campaign,
                vault,
                sender: self.sender.pubkey(),
                sender_token: self.sender_token.pubkey(),
                mint: self.mint.pubkey(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.sender, &[instruction], &[]).unwrap();
        (campaign, vault)
    }

    fn submit_research(&mut self, campaign: Pubkey, hash: [u8; 32]) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::SubmitResearch {
                research_hash: hash,
            }
            .data(),
            gift_campaign::accounts::SubmitResearch {
                config: self.config,
                campaign,
                research_oracle: self.research_oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.research_oracle, &[instruction], &[])
    }

    fn approve_with(
        &mut self,
        campaign: Pubkey,
        signer: &Keypair,
        hash: [u8; 32],
    ) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::ApproveGift { gift_hash: hash }.data(),
            gift_campaign::accounts::ApproveGift {
                campaign,
                sender: signer.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, signer, &[instruction], &[])
    }

    fn approve(&mut self, campaign: Pubkey, hash: [u8; 32]) -> TransactionResult {
        let sender = Keypair::try_from(self.sender.to_bytes().as_slice()).unwrap();
        self.approve_with(campaign, &sender, hash)
    }

    fn submit_exact_quote(&mut self, campaign: Pubkey, total: u64) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::SubmitQuote {
                quote_version: 1,
                job_kind: 0,
                adapter: 0,
                spec_hash: SPEC_HASH,
                quote_hash: QUOTE_HASH,
                merchant_hash: MERCHANT_HASH,
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
                landed_total_minor: total,
                max_total_minor: 8_000,
                settlement_amount: SETTLEMENT_AMOUNT,
                quoted_charge_amount_minor: CHARGE_TOTAL_MINOR,
                settlement_units_per_charge_unit_micros: SETTLEMENT_UNITS_PER_CHARGE_UNIT_MICROS,
                quote_captured_at: 0,
                quote_expires_at: 5_000,
            }
            .data(),
            gift_campaign::accounts::SubmitQuote {
                config: self.config,
                campaign,
                research_oracle: self.research_oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.research_oracle, &[instruction], &[])
    }

    fn approve_exact_quote(&mut self, campaign: Pubkey) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::ApproveQuote {
                quote_version: 1,
                quote_hash: QUOTE_HASH,
            }
            .data(),
            gift_campaign::accounts::ApproveQuote {
                campaign,
                sender: self.sender.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.sender, &[instruction], &[])
    }

    fn record_payment_attempt(&mut self, campaign: Pubkey) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::RecordPaymentAttempt {
                quote_version: 1,
                quote_hash: QUOTE_HASH,
                payment_attempt_hash: PAYMENT_ATTEMPT_HASH,
            }
            .data(),
            gift_campaign::accounts::RecordPaymentAttempt {
                config: self.config,
                campaign,
                fulfillment_oracle: self.delivery_oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.delivery_oracle, &[instruction], &[])
    }

    fn record_payment_auth(&mut self, campaign: Pubkey, amount: u64) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::RecordPaymentAuth {
                payment_auth_hash: PAYMENT_AUTH_HASH,
                currency: *b"EUR",
                authenticated_amount_minor: amount,
            }
            .data(),
            gift_campaign::accounts::RecordPaymentAuth {
                config: self.config,
                campaign,
                fulfillment_oracle: self.delivery_oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.delivery_oracle, &[instruction], &[])
    }

    fn record_purchase(&mut self, campaign: Pubkey) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::RecordPurchase {
                purchase_hash: PURCHASE_HASH,
                order_id_hash: ORDER_ID_HASH,
                currency: *b"EUR",
                charged_amount_minor: CHARGE_TOTAL_MINOR,
            }
            .data(),
            gift_campaign::accounts::RecordPurchase {
                config: self.config,
                campaign,
                fulfillment_oracle: self.delivery_oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.delivery_oracle, &[instruction], &[])
    }

    fn settle_fulfillment(&mut self, campaign: Pubkey, vault: Pubkey) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::SettleFulfillment {
                pod_hash: POD_HASH,
                fulfillment_hash: FULFILLMENT_HASH,
            }
            .data(),
            gift_campaign::accounts::SettleFulfillment {
                config: self.config,
                campaign,
                vault,
                sender_token: self.sender_token.pubkey(),
                treasury_token: self.treasury_token.pubkey(),
                operator_token: self.operator_token.pubkey(),
                fulfillment_oracle: self.delivery_oracle.pubkey(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.delivery_oracle, &[instruction], &[])
    }

    fn confirm_delivery(&mut self, campaign: Pubkey, vault: Pubkey) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::ConfirmDelivery { pod_hash: POD_HASH }.data(),
            gift_campaign::accounts::ConfirmDelivery {
                config: self.config,
                campaign,
                vault,
                sender_token: self.sender_token.pubkey(),
                treasury_token: self.treasury_token.pubkey(),
                delivery_oracle: self.delivery_oracle.pubkey(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, &self.delivery_oracle, &[instruction], &[])
    }

    fn cancel_with(
        &mut self,
        campaign: Pubkey,
        vault: Pubkey,
        signer: &Keypair,
    ) -> TransactionResult {
        let instruction = Instruction::new_with_bytes(
            gift_campaign::id(),
            &gift_campaign::instruction::Cancel {}.data(),
            gift_campaign::accounts::Cancel {
                config: self.config,
                campaign,
                vault,
                sender_token: self.sender_token.pubkey(),
                canceller: signer.pubkey(),
                token_program: anchor_spl::token::ID,
            }
            .to_account_metas(None),
        );
        send(&mut self.svm, signer, &[instruction], &[])
    }

    fn campaign(&self, address: Pubkey) -> Campaign {
        let account = self.svm.get_account(&address).unwrap();
        Campaign::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}

fn send(
    svm: &mut LiteSVM,
    fee_payer: &Keypair,
    instructions: &[Instruction],
    additional_signers: &[&Keypair],
) -> TransactionResult {
    let message = Message::new_with_blockhash(
        instructions,
        Some(&fee_payer.pubkey()),
        &svm.latest_blockhash(),
    );
    let mut signers: Vec<&dyn Signer> = vec![fee_payer];
    signers.extend(
        additional_signers
            .iter()
            .copied()
            .map(|signer| signer as &dyn Signer),
    );
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers).unwrap();
    svm.send_transaction(transaction)
}

fn create_mint_and_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    owner: &Pubkey,
    amount: u64,
) -> (Keypair, Keypair) {
    let mint = Keypair::new();
    let mint_space = spl_token::state::Mint::LEN;
    let create_mint = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        svm.minimum_balance_for_rent_exemption(mint_space),
        mint_space as u64,
        &anchor_spl::token::ID,
    );
    let initialize_mint = spl_token::instruction::initialize_mint2(
        &anchor_spl::token::ID,
        &mint.pubkey(),
        &payer.pubkey(),
        None,
        6,
    )
    .unwrap();
    send(svm, payer, &[create_mint, initialize_mint], &[&mint]).unwrap();

    let token = create_token_account(svm, payer, &mint.pubkey(), owner);
    let mint_to = spl_token::instruction::mint_to(
        &anchor_spl::token::ID,
        &mint.pubkey(),
        &token.pubkey(),
        &payer.pubkey(),
        &[],
        amount,
    )
    .unwrap();
    send(svm, payer, &[mint_to], &[]).unwrap();
    (mint, token)
}

fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: &Pubkey,
    owner: &Pubkey,
) -> Keypair {
    let token = Keypair::new();
    let account_space = spl_token::state::Account::LEN;
    let create = system_instruction::create_account(
        &payer.pubkey(),
        &token.pubkey(),
        svm.minimum_balance_for_rent_exemption(account_space),
        account_space as u64,
        &anchor_spl::token::ID,
    );
    let initialize = spl_token::instruction::initialize_account3(
        &anchor_spl::token::ID,
        &token.pubkey(),
        mint,
        owner,
    )
    .unwrap();
    send(svm, payer, &[create, initialize], &[&token]).unwrap();
    token
}

fn token_balance(svm: &LiteSVM, token_account: Pubkey) -> u64 {
    let account = svm.get_account(&token_account).unwrap();
    TokenAccount::try_deserialize_unchecked(&mut account.data.as_slice())
        .unwrap()
        .amount
}

#[test]
fn happy_path_splits_fee_and_refunds_sender() {
    let mut fixture = Fixture::new();
    let nonce = 1;
    let (campaign, vault) = fixture.create_campaign(nonce, FUTURE_EXPIRY);

    assert_eq!(token_balance(&fixture.svm, vault), BUDGET);
    fixture.submit_research(campaign, RESEARCH_HASH).unwrap();
    fixture.approve(campaign, GIFT_HASH).unwrap();
    fixture.confirm_delivery(campaign, vault).unwrap();

    let expected_fee = BUDGET * u64::from(FEE_BPS) / 10_000;
    assert_eq!(token_balance(&fixture.svm, vault), 0);
    assert_eq!(
        token_balance(&fixture.svm, fixture.treasury_token.pubkey()),
        expected_fee
    );
    assert_eq!(
        token_balance(&fixture.svm, fixture.sender_token.pubkey()),
        INITIAL_TOKENS - expected_fee
    );

    let state = fixture.campaign(campaign);
    assert_eq!(state.status, CampaignStatus::Settled);
    assert_eq!(state.research_hash, RESEARCH_HASH);
    assert_eq!(state.gift_hash, GIFT_HASH);
    assert_eq!(state.pod_hash, POD_HASH);
}

#[test]
fn exact_fulfillment_lifecycle_records_quote_auth_purchase_and_settlement() {
    let mut fixture = Fixture::new();
    let (campaign, vault) = fixture.create_campaign(7, FUTURE_EXPIRY);

    fixture
        .submit_exact_quote(campaign, QUOTE_TOTAL_MINOR)
        .unwrap();
    fixture.approve_exact_quote(campaign).unwrap();
    fixture.record_payment_attempt(campaign).unwrap();
    fixture
        .record_payment_auth(campaign, CHARGE_TOTAL_MINOR)
        .unwrap();
    fixture.record_purchase(campaign).unwrap();
    fixture.settle_fulfillment(campaign, vault).unwrap();

    let fee = SETTLEMENT_AMOUNT * u64::from(FEE_BPS) / 10_000;
    assert_eq!(token_balance(&fixture.svm, vault), 0);
    assert_eq!(
        token_balance(&fixture.svm, fixture.operator_token.pubkey()),
        SETTLEMENT_AMOUNT
    );
    assert_eq!(
        token_balance(&fixture.svm, fixture.treasury_token.pubkey()),
        fee
    );
    assert_eq!(
        token_balance(&fixture.svm, fixture.sender_token.pubkey()),
        INITIAL_TOKENS - SETTLEMENT_AMOUNT - fee
    );

    let state = fixture.campaign(campaign);
    assert_eq!(state.status, CampaignStatus::Settled);
    assert_eq!(state.spec_hash, SPEC_HASH);
    assert_eq!(state.quote_hash, QUOTE_HASH);
    assert_eq!(state.landed_total_minor, QUOTE_TOTAL_MINOR);
    assert_eq!(state.payment_attempt_hash, PAYMENT_ATTEMPT_HASH);
    assert_eq!(state.payment_auth_hash, PAYMENT_AUTH_HASH);
    assert_eq!(state.purchase_hash, PURCHASE_HASH);
    assert_eq!(state.order_id_hash, ORDER_ID_HASH);
    assert_eq!(state.fulfillment_hash, FULFILLMENT_HASH);
    assert_eq!(state.currency, *b"PLN");
    assert_eq!(state.currency_exponent, 2);
    assert_eq!(state.charge_currency, *b"EUR");
    assert_eq!(state.charge_currency_exponent, 2);
    assert_eq!(state.quoted_charge_amount_minor, CHARGE_TOTAL_MINOR);
    assert_eq!(
        state.settlement_units_per_charge_unit_micros,
        SETTLEMENT_UNITS_PER_CHARGE_UNIT_MICROS
    );
    assert_eq!(state.charged_amount_minor, CHARGE_TOTAL_MINOR);
    assert_eq!(state.spent, SETTLEMENT_AMOUNT);
}

#[test]
fn exact_fulfillment_rejects_quote_and_auth_amount_mismatches() {
    let mut fixture = Fixture::new();
    let (bad_campaign, _) = fixture.create_campaign(8, FUTURE_EXPIRY);
    assert!(fixture
        .submit_exact_quote(bad_campaign, QUOTE_TOTAL_MINOR + 1)
        .is_err());
    assert_eq!(
        fixture.campaign(bad_campaign).status,
        CampaignStatus::Funded
    );

    let (campaign, _) = fixture.create_campaign(9, FUTURE_EXPIRY);
    fixture
        .submit_exact_quote(campaign, QUOTE_TOTAL_MINOR)
        .unwrap();
    fixture.approve_exact_quote(campaign).unwrap();
    fixture.record_payment_attempt(campaign).unwrap();
    assert!(fixture
        .record_payment_auth(campaign, CHARGE_TOTAL_MINOR + 1)
        .is_err());
    assert_eq!(
        fixture.campaign(campaign).status,
        CampaignStatus::PaymentAttempted
    );
}

#[test]
fn rejects_non_sender_approval_and_delivery_before_approval() {
    let mut fixture = Fixture::new();
    let (campaign, vault) = fixture.create_campaign(2, FUTURE_EXPIRY);
    assert!(fixture.confirm_delivery(campaign, vault).is_err());
    fixture.submit_research(campaign, RESEARCH_HASH).unwrap();

    let attacker = Keypair::try_from(fixture.attacker.to_bytes().as_slice()).unwrap();
    assert!(fixture
        .approve_with(campaign, &attacker, GIFT_HASH)
        .is_err());
    assert_eq!(
        fixture.campaign(campaign).status,
        CampaignStatus::Researched
    );
}

#[test]
fn rejects_zero_hashes() {
    let mut fixture = Fixture::new();
    let (campaign, _) = fixture.create_campaign(3, FUTURE_EXPIRY);
    assert!(fixture.submit_research(campaign, [0; 32]).is_err());
    fixture.submit_research(campaign, RESEARCH_HASH).unwrap();
    assert!(fixture.approve(campaign, [0; 32]).is_err());
}

#[test]
fn sender_can_cancel_and_receive_full_refund() {
    let mut fixture = Fixture::new();
    let (campaign, vault) = fixture.create_campaign(4, FUTURE_EXPIRY);
    let sender = Keypair::try_from(fixture.sender.to_bytes().as_slice()).unwrap();
    fixture.cancel_with(campaign, vault, &sender).unwrap();

    assert_eq!(
        token_balance(&fixture.svm, fixture.sender_token.pubkey()),
        INITIAL_TOKENS
    );
    assert_eq!(token_balance(&fixture.svm, vault), 0);
    assert_eq!(fixture.campaign(campaign).status, CampaignStatus::Cancelled);
}

#[test]
fn delivery_oracle_can_cancel_only_after_expiry() {
    let mut fixture = Fixture::new();
    let expiry = 100;
    let (campaign, vault) = fixture.create_campaign(5, expiry);
    let oracle = Keypair::try_from(fixture.delivery_oracle.to_bytes().as_slice()).unwrap();
    assert!(fixture.cancel_with(campaign, vault, &oracle).is_err());

    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = expiry + 1;
    fixture.svm.set_sysvar(&clock);
    fixture.svm.expire_blockhash();
    fixture.cancel_with(campaign, vault, &oracle).unwrap();
    assert_eq!(fixture.campaign(campaign).status, CampaignStatus::Cancelled);
}

#[test]
fn attempted_payment_blocks_sender_refund_but_oracle_can_recover_after_expiry() {
    let mut fixture = Fixture::new();
    let (campaign, vault) = fixture.create_campaign(10, FUTURE_EXPIRY);
    fixture
        .submit_exact_quote(campaign, QUOTE_TOTAL_MINOR)
        .unwrap();
    fixture.approve_exact_quote(campaign).unwrap();
    fixture.record_payment_attempt(campaign).unwrap();

    let sender = Keypair::try_from(fixture.sender.to_bytes().as_slice()).unwrap();
    assert!(fixture.cancel_with(campaign, vault, &sender).is_err());

    let mut clock = fixture.svm.get_sysvar::<Clock>();
    clock.unix_timestamp = FUTURE_EXPIRY + 1;
    fixture.svm.set_sysvar(&clock);
    fixture.svm.expire_blockhash();
    let oracle = Keypair::try_from(fixture.delivery_oracle.to_bytes().as_slice()).unwrap();
    fixture.cancel_with(campaign, vault, &oracle).unwrap();
    assert_eq!(fixture.campaign(campaign).status, CampaignStatus::Cancelled);
    assert_eq!(token_balance(&fixture.svm, vault), 0);
}

#[test]
fn rejects_a_campaign_funded_with_the_wrong_mint() {
    let mut fixture = Fixture::new();
    let (wrong_mint, wrong_sender_token) = create_mint_and_token_account(
        &mut fixture.svm,
        &fixture.payer,
        &fixture.sender.pubkey(),
        INITIAL_TOKENS,
    );
    let nonce = 6;
    let (campaign, vault) = fixture.campaign_addresses(nonce);
    let instruction = Instruction::new_with_bytes(
        gift_campaign::id(),
        &gift_campaign::instruction::CreateCampaign {
            nonce,
            budget: BUDGET,
            expires_at: FUTURE_EXPIRY,
        }
        .data(),
        gift_campaign::accounts::CreateCampaign {
            config: fixture.config,
            campaign,
            vault,
            sender: fixture.sender.pubkey(),
            sender_token: wrong_sender_token.pubkey(),
            mint: wrong_mint.pubkey(),
            token_program: anchor_spl::token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(send(&mut fixture.svm, &fixture.sender, &[instruction], &[]).is_err());
}
