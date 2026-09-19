//! JSON-lines bridge to the actual gift_campaign SBF inside ephemeral LiteSVM.
//! No RPC, real funds, wallet files, merchant requests, or persistent private keys.
#![recursion_limit = "256"]
use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::{instruction::Instruction, program_pack::Pack, system_program},
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::{spl_token, TokenAccount};
use gift_campaign::{
    constants::{CAMPAIGN_SEED, CONFIG_SEED, MANDATE_SEED, VAULT_SEED},
    mandate::quote_terms_hash,
    state::{Campaign, Config, Mandate, MandateStatus},
};
use litesvm::{types::TransactionResult, LiteSVM};
use serde::Deserialize;
use serde_json::{json, Value};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_system_interface::instruction as system_instruction;
use solana_transaction::versioned::VersionedTransaction;
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, String>;
const MAX_LINE: usize = 16_384;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Quote {
    merchant_hash: String,
    spec_hash: String,
    recipient_hash: String,
    quote_hash: String,
    currency: String,
    currency_exponent: u8,
    total_minor: u64,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Prepare {
        quote: Quote,
    },
    Authorize {
        #[serde(rename = "termsHash")]
        terms_hash: String,
    },
    Attempt {
        #[serde(rename = "termsHash")]
        terms_hash: String,
        #[serde(rename = "attemptHash")]
        attempt_hash: String,
    },
    Confirm {
        #[serde(rename = "orderHash")]
        order_hash: String,
        #[serde(rename = "receiptHash")]
        receipt_hash: String,
    },
    State {},
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn hash32(text: &str) -> Result<[u8; 32]> {
    if text.len() != 64 || !text.bytes().all(|v| v.is_ascii_hexdigit()) {
        return Err("hash_must_be_64_hex_characters".into());
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(out)
}
fn now() -> Result<i64> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs(),
    )
    .map_err(|e| e.to_string())
}
fn instruction(
    data: Vec<u8>,
    accounts: Vec<anchor_lang::solana_program::instruction::AccountMeta>,
) -> Instruction {
    Instruction::new_with_bytes(gift_campaign::ID, &data, accounts)
}

// These are actual returned transaction logs and signatures, including failures.
fn record_result(
    result: TransactionResult,
    label: &str,
    transactions: &mut Vec<Value>,
) -> Result<()> {
    let (accepted, error, meta) = match result {
        Ok(meta) => (true, None, meta),
        Err(failure) => (false, Some(format!("{:?}", failure.err)), failure.meta),
    };
    transactions.push(json!({"label":label,"accepted":accepted,"error":error,
        "signature":meta.signature.to_string(),"logs":meta.logs,
        "computeUnits":meta.compute_units_consumed}));
    if accepted {
        Ok(())
    } else {
        Err(error.unwrap_or_else(|| "transaction_rejected".into()))
    }
}
fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    ixs: &[Instruction],
    extra: &[&Keypair],
    label: &str,
    txs: &mut Vec<Value>,
) -> Result<()> {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = now()?;
    svm.set_sysvar(&clock);
    // Every command/retry receives a fresh signature: rejection is not deduplication.
    svm.expire_blockhash();
    let message = Message::new_with_blockhash(ixs, Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut signers: Vec<&dyn Signer> = vec![payer];
    signers.extend(extra.iter().copied().map(|s| s as &dyn Signer));
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &signers)
        .map_err(|e| format!("transaction_signing_failed:{e}"))?;
    record_result(svm.send_transaction(transaction), label, txs)
}

struct Bridge {
    svm: LiteSVM,
    payer: Keypair,
    sender: Keypair,
    executor: Keypair,
    research: Keypair,
    oracle: Keypair,
    treasury: Keypair,
    mint: Keypair,
    sender_token: Keypair,
    config: Pubkey,
    campaign: Pubkey,
    vault: Pubkey,
    mandate: Pubkey,
    mandate_bump: u8,
    binary_hash: String,
    prepared: bool,
    planned: Option<Mandate>,
    poisoned: bool,
}

impl Bridge {
    fn new() -> Result<Self> {
        let path = std::env::var_os("GIFTING_PROGRAM_SO")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../target/deploy/gift_campaign.so")
            });
        let bytes = std::fs::read(&path).map_err(|e| format!("program_read_failed:{e}"))?;
        let mut svm = LiteSVM::new();
        svm.add_program(gift_campaign::ID, &bytes)
            .map_err(|e| format!("program_load_failed:{e}"))?;
        let sender = Keypair::new();
        let campaign = Pubkey::find_program_address(
            &[CAMPAIGN_SEED, sender.pubkey().as_ref(), &1u64.to_le_bytes()],
            &gift_campaign::ID,
        )
        .0;
        let vault =
            Pubkey::find_program_address(&[VAULT_SEED, campaign.as_ref()], &gift_campaign::ID).0;
        let (mandate, mandate_bump) =
            Pubkey::find_program_address(&[MANDATE_SEED, campaign.as_ref()], &gift_campaign::ID);
        Ok(Self {
            svm,
            sender,
            payer: Keypair::new(),
            executor: Keypair::new(),
            research: Keypair::new(),
            oracle: Keypair::new(),
            treasury: Keypair::new(),
            mint: Keypair::new(),
            sender_token: Keypair::new(),
            config: Pubkey::find_program_address(&[CONFIG_SEED], &gift_campaign::ID).0,
            campaign,
            vault,
            mandate,
            mandate_bump,
            binary_hash: hex(&solana_sha256_hasher::hash(&bytes).to_bytes()),
            prepared: false,
            planned: None,
            poisoned: false,
        })
    }
    fn decode<T: AccountDeserialize>(&self, key: Pubkey) -> Result<Option<T>> {
        match self.svm.get_account(&key) {
            None => Ok(None),
            Some(account) => T::try_deserialize(&mut account.data.as_slice())
                .map(Some)
                .map_err(|e| format!("account_decode_failed:{key}:{e}")),
        }
    }
    fn campaign_state(&self) -> Result<Campaign> {
        self.decode(self.campaign)?
            .ok_or_else(|| "campaign_not_prepared".into())
    }
    fn prepare(&mut self, q: Quote, txs: &mut Vec<Value>) -> Result<()> {
        if self.prepared {
            return Err("one_campaign_per_process_start_new_bridge".into());
        }
        let merchant = hash32(&q.merchant_hash)?;
        let spec = hash32(&q.spec_hash)?;
        let recipient = hash32(&q.recipient_hash)?;
        let quote = hash32(&q.quote_hash)?;
        if q.currency != "PLN"
            || q.currency_exponent != 2
            || q.total_minor == 0
            || q.total_minor > 10_000_000
        {
            return Err("fixture_requires_PLN_exponent_2_total_1_to_10000000".into());
        }
        if [merchant, spec, recipient, quote]
            .iter()
            .any(|h| *h == [0; 32])
        {
            return Err("zero_hash".into());
        }
        let captured = now()?;
        // Input validation does not substitute for program expiry validation on later instructions.
        if q.expires_at <= captured {
            return Err("prepare_expiry_must_be_in_future".into());
        }
        let settlement = q
            .total_minor
            .checked_mul(10_000)
            .ok_or("settlement_overflow")?;
        self.prepared = true; // A partial setup is never silently reset/reused.
        for key in [
            &self.payer,
            &self.sender,
            &self.executor,
            &self.research,
            &self.oracle,
            &self.treasury,
        ] {
            record_result(
                self.svm.airdrop(&key.pubkey(), 10_000_000_000),
                "fixture_airdrop",
                txs,
            )?;
        }
        let mint_space = spl_token::state::Mint::LEN;
        let create_mint = system_instruction::create_account(
            &self.payer.pubkey(),
            &self.mint.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(mint_space),
            mint_space as u64,
            &anchor_spl::token::ID,
        );
        let init_mint = spl_token::instruction::initialize_mint2(
            &anchor_spl::token::ID,
            &self.mint.pubkey(),
            &self.payer.pubkey(),
            None,
            6,
        )
        .map_err(|e| e.to_string())?;
        send(
            &mut self.svm,
            &self.payer,
            &[create_mint, init_mint],
            &[&self.mint],
            "create_demo_mint",
            txs,
        )?;
        let space = spl_token::state::Account::LEN;
        let create_token = system_instruction::create_account(
            &self.payer.pubkey(),
            &self.sender_token.pubkey(),
            self.svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &anchor_spl::token::ID,
        );
        let init_token = spl_token::instruction::initialize_account3(
            &anchor_spl::token::ID,
            &self.sender_token.pubkey(),
            &self.mint.pubkey(),
            &self.sender.pubkey(),
        )
        .map_err(|e| e.to_string())?;
        let mint_to = spl_token::instruction::mint_to(
            &anchor_spl::token::ID,
            &self.mint.pubkey(),
            &self.sender_token.pubkey(),
            &self.payer.pubkey(),
            &[],
            settlement,
        )
        .map_err(|e| e.to_string())?;
        send(
            &mut self.svm,
            &self.payer,
            &[create_token, init_token, mint_to],
            &[&self.sender_token],
            "fund_demo_tokens",
            txs,
        )?;
        let init = instruction(
            gift_campaign::instruction::Initialize { fee_bps: 0 }.data(),
            gift_campaign::accounts::Initialize {
                config: self.config,
                authority: self.payer.pubkey(),
                treasury: self.treasury.pubkey(),
                research_oracle: self.research.pubkey(),
                delivery_oracle: self.oracle.pubkey(),
                allowed_mint: self.mint.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(
            &mut self.svm,
            &self.payer,
            &[init],
            &[],
            "initialize_program_config",
            txs,
        )?;
        let create = instruction(
            gift_campaign::instruction::CreateCampaign {
                nonce: 1,
                budget: settlement,
                expires_at: q.expires_at,
            }
            .data(),
            gift_campaign::accounts::CreateCampaign {
                config: self.config,
                campaign: self.campaign,
                vault: self.vault,
                sender: self.sender.pubkey(),
                sender_token: self.sender_token.pubkey(),
                mint: self.mint.pubkey(),
                token_program: anchor_spl::token::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        send(
            &mut self.svm,
            &self.sender,
            &[create],
            &[],
            "create_funded_campaign",
            txs,
        )?;
        let submit = instruction(
            gift_campaign::instruction::SubmitQuote {
                quote_version: 1,
                job_kind: 0,
                adapter: 0,
                spec_hash: spec,
                quote_hash: quote,
                merchant_hash: merchant,
                currency: *b"PLN",
                currency_exponent: 2,
                charge_currency: *b"PLN",
                charge_currency_exponent: 2,
                item_subtotal_minor: q.total_minor,
                small_order_fee_minor: 0,
                service_fee_minor: 0,
                delivery_fee_minor: 0,
                tip_minor: 0,
                other_fees_minor: 0,
                landed_total_minor: q.total_minor,
                max_total_minor: q.total_minor,
                settlement_amount: settlement,
                quoted_charge_amount_minor: q.total_minor,
                settlement_units_per_charge_unit_micros: 1_000_000,
                quote_captured_at: captured,
                quote_expires_at: q.expires_at,
            }
            .data(),
            gift_campaign::accounts::SubmitQuote {
                config: self.config,
                campaign: self.campaign,
                research_oracle: self.research.pubkey(),
            }
            .to_account_metas(None),
        );
        send(
            &mut self.svm,
            &self.research,
            &[submit],
            &[],
            "submit_quote",
            txs,
        )?;
        self.planned = Some(Mandate {
            campaign: self.campaign,
            sender: self.sender.pubkey(),
            executor: self.executor.pubkey(),
            merchant_hash: merchant,
            spec_hash: spec,
            recipient_hash: recipient,
            charge_currency: *b"PLN",
            charge_currency_exponent: 2,
            max_charge_amount_minor: q.total_minor,
            max_escrow_debit: settlement,
            expires_at: q.expires_at,
            status: MandateStatus::Active,
            approved_terms_hash: [0; 32],
            consumed_at: 0,
            bump: self.mandate_bump,
        });
        Ok(())
    }
    fn authorize(&mut self, hash: [u8; 32], txs: &mut Vec<Value>) -> Result<()> {
        let m = self.planned.as_ref().ok_or("quote_not_prepared")?;
        // Two program instructions in one signed transaction: invalid terms roll back mandate creation too.
        let auth = instruction(
            gift_campaign::instruction::AuthorizeMandate {
                executor: m.executor,
                merchant_hash: m.merchant_hash,
                spec_hash: m.spec_hash,
                recipient_hash: m.recipient_hash,
                charge_currency: m.charge_currency,
                charge_currency_exponent: m.charge_currency_exponent,
                max_charge_amount_minor: m.max_charge_amount_minor,
                max_escrow_debit: m.max_escrow_debit,
                expires_at: m.expires_at,
            }
            .data(),
            gift_campaign::accounts::AuthorizeMandate {
                campaign: self.campaign,
                mandate: self.mandate,
                sender: self.sender.pubkey(),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        let approve = instruction(
            gift_campaign::instruction::ApproveQuoteWithMandate {
                quote_version: 1,
                terms_hash: hash,
            }
            .data(),
            gift_campaign::accounts::ApproveQuoteWithMandate {
                config: self.config,
                campaign: self.campaign,
                mandate: self.mandate,
                executor: self.executor.pubkey(),
            }
            .to_account_metas(None),
        );
        send(
            &mut self.svm,
            &self.sender,
            &[auth, approve],
            &[&self.executor],
            "authorize_and_approve_exact_quote",
            txs,
        )
    }
    fn attempt(&mut self, hash: [u8; 32], attempt: [u8; 32], txs: &mut Vec<Value>) -> Result<()> {
        let ix = instruction(
            gift_campaign::instruction::RecordPaymentAttemptWithMandate {
                terms_hash: hash,
                payment_attempt_hash: attempt,
            }
            .data(),
            gift_campaign::accounts::RecordPaymentAttemptWithMandate {
                config: self.config,
                campaign: self.campaign,
                mandate: self.mandate,
                executor: self.executor.pubkey(),
            }
            .to_account_metas(None),
        );
        send(
            &mut self.svm,
            &self.executor,
            &[ix],
            &[],
            "consume_mandate_and_record_attempt",
            txs,
        )
    }
    fn confirm(&mut self, order: [u8; 32], receipt: [u8; 32], txs: &mut Vec<Value>) -> Result<()> {
        let c = self.campaign_state()?;
        // Caller invokes only after verifying its simulated merchant result. This signer is a fixture oracle, not merchant attestation.
        let auth_hash =
            solana_sha256_hasher::hashv(&[b"local-fixture-payment-auth:v1", &receipt, &order])
                .to_bytes();
        let auth = instruction(
            gift_campaign::instruction::RecordPaymentAuth {
                payment_auth_hash: auth_hash,
                currency: c.charge_currency,
                authenticated_amount_minor: c.quoted_charge_amount_minor,
            }
            .data(),
            gift_campaign::accounts::RecordPaymentAuth {
                config: self.config,
                campaign: self.campaign,
                fulfillment_oracle: self.oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        let purchased = instruction(
            gift_campaign::instruction::RecordPurchase {
                purchase_hash: receipt,
                order_id_hash: order,
                currency: c.charge_currency,
                charged_amount_minor: c.quoted_charge_amount_minor,
            }
            .data(),
            gift_campaign::accounts::RecordPurchase {
                config: self.config,
                campaign: self.campaign,
                fulfillment_oracle: self.oracle.pubkey(),
            }
            .to_account_metas(None),
        );
        send(
            &mut self.svm,
            &self.oracle,
            &[auth, purchased],
            &[],
            "fixture_oracle_authenticate_and_confirm",
            txs,
        )
    }
    fn dispatch(&mut self, command: Command, txs: &mut Vec<Value>) -> Result<()> {
        if self.poisoned && !matches!(command, Command::State {}) {
            return Err("bridge_internal_failure_state_only".into());
        }
        match command {
            Command::Prepare { quote } => self.prepare(quote, txs),
            Command::Authorize { terms_hash } => self.authorize(hash32(&terms_hash)?, txs),
            Command::Attempt {
                terms_hash,
                attempt_hash,
            } => self.attempt(hash32(&terms_hash)?, hash32(&attempt_hash)?, txs),
            Command::Confirm {
                order_hash,
                receipt_hash,
            } => self.confirm(hash32(&order_hash)?, hash32(&receipt_hash)?, txs),
            Command::State {} => Ok(()),
        }
    }
    fn public_keys(&self) -> Value {
        json!({"program":gift_campaign::ID.to_string(),"campaign":self.campaign.to_string(),"mandate":self.mandate.to_string(),
        "vault":self.vault.to_string(),"config":self.config.to_string(),"mint":self.mint.pubkey().to_string(),"sender":self.sender.pubkey().to_string(),
        "executor":self.executor.pubkey().to_string(),"researchOracle":self.research.pubkey().to_string(),"fulfillmentOracle":self.oracle.pubkey().to_string(),
        "fixturePayer":self.payer.pubkey().to_string(),"treasury":self.treasury.pubkey().to_string(),"senderToken":self.sender_token.pubkey().to_string()})
    }
    fn token_balance(&self, key: Pubkey) -> Option<String> {
        self.svm
            .get_account(&key)
            .and_then(|a| TokenAccount::try_deserialize_unchecked(&mut a.data.as_slice()).ok())
            .map(|a| a.amount.to_string())
    }
    fn state(&self) -> Result<Value> {
        Ok(
            json!({"campaign":self.decode::<Campaign>(self.campaign)?.as_ref().map(campaign_json),
            "mandate":self.decode::<Mandate>(self.mandate)?.as_ref().map(mandate_json),
            "config":self.decode::<Config>(self.config)?.map(|c|json!({"authority":c.authority.to_string(),"treasury":c.treasury.to_string(),
                "researchOracle":c.research_oracle.to_string(),"deliveryOracle":c.delivery_oracle.to_string(),"allowedMint":c.allowed_mint.to_string(),"feeBps":c.fee_bps,"bump":c.bump})),
            "balances":{"vaultDemoTokenUnits":self.token_balance(self.vault),"senderDemoTokenUnits":self.token_balance(self.sender_token.pubkey())},
            "clockUnixSeconds":self.svm.get_sysvar::<Clock>().unix_timestamp.to_string(),"bridgePoisoned":self.poisoned}),
        )
    }
    fn canonical(&self) -> Result<Option<Value>> {
        let c = match self.decode::<Campaign>(self.campaign)? {
            Some(c) => c,
            None => return Ok(None),
        };
        let cfg: Config = match self.decode(self.config)? {
            Some(c) => c,
            None => return Ok(None),
        };
        let account_m: Option<Mandate> = self.decode(self.mandate)?;
        let m = match account_m.as_ref().or(self.planned.as_ref()) {
            Some(m) => m,
            None => return Ok(None),
        };
        let bytes = canonical_bytes(self.campaign, self.mandate, &c, m, &cfg);
        let digest = quote_terms_hash(self.campaign, self.mandate, &c, m, &cfg);
        if solana_sha256_hasher::hash(&bytes).to_bytes() != digest {
            return Err("bridge_canonical_encoding_mismatch".into());
        }
        let mut cj = campaign_json(&c);
        // Canonical inputs intentionally contain only digest fields; 64-bit values are decimal strings.
        let cm = cj.as_object_mut().ok_or("campaign_json_invalid")?;
        let names = [
            "quoteVersion",
            "jobKind",
            "adapter",
            "specHash",
            "quoteHash",
            "merchantHash",
            "currency",
            "currencyExponent",
            "chargeCurrency",
            "chargeCurrencyExponent",
            "itemSubtotalMinor",
            "smallOrderFeeMinor",
            "serviceFeeMinor",
            "deliveryFeeMinor",
            "tipMinor",
            "otherFeesMinor",
            "landedTotalMinor",
            "maxTotalMinor",
            "settlementAmount",
            "quotedChargeAmountMinor",
            "settlementUnitsPerChargeUnitMicros",
            "quoteCapturedAt",
            "quoteExpiresAt",
            "expiresAt",
        ];
        cm.retain(|k, _| names.contains(&k.as_str()));
        let mj = json!({"campaign":hex(m.campaign.as_ref()),"sender":hex(m.sender.as_ref()),"executor":hex(m.executor.as_ref()),
            "merchantHash":hex(&m.merchant_hash),"specHash":hex(&m.spec_hash),"recipientHash":hex(&m.recipient_hash),
            "chargeCurrency":String::from_utf8_lossy(&m.charge_currency),"chargeCurrencyExponent":m.charge_currency_exponent,
            "maxChargeAmountMinor":m.max_charge_amount_minor.to_string(),"maxEscrowDebit":m.max_escrow_debit.to_string(),"expiresAt":m.expires_at.to_string()});
        Ok(Some(
            json!({"domain":"gift-campaign:mandate-quote:v1","mandateSource":if account_m.is_some(){"account"}else{"planned"},
            "inputs":{"programId":hex(gift_campaign::ID.as_ref()),"campaignKey":hex(self.campaign.as_ref()),"mandateKey":hex(self.mandate.as_ref()),
                "config":{"allowedMint":hex(cfg.allowed_mint.as_ref()),"feeBps":cfg.fee_bps},"mandate":mj,"campaign":cj},
            "bytesHex":hex(&bytes),"termsHash":hex(&digest)}),
        ))
    }
    fn response(&self, result: Result<()>, transactions: Vec<Value>) -> Value {
        let state = self.state();
        let canonical = self.canonical();
        let error = result
            .err()
            .or_else(|| state.as_ref().err().cloned())
            .or_else(|| canonical.as_ref().err().cloned());
        json!({"accepted":error.is_none(),"error":error.map(|detail|json!({"code":"bridge_or_program_rejected","detail":detail})),
            "backend":"LiteSVM local Solana","ephemeralDemoSigners":true,"network":"none","realFunds":false,
            "merchantConfirmationSource":"trusted local fixture oracle; no external merchant verification",
            "settlementFixture":{"mintDecimals":6,"demoTokensPerPLN":1,"protocolFeeBps":0,"realFX":false},
            "binarySha256":self.binary_hash,"publicKeys":self.public_keys(),"transactions":transactions,
            "state":state.ok(),"canonical":canonical.ok().flatten()})
    }
}

fn campaign_json(c: &Campaign) -> Value {
    json!({"sender":c.sender.to_string(),"mandate":c.mandate.to_string(),"nonce":c.nonce.to_string(),"budget":c.budget.to_string(),"spent":c.spent.to_string(),
        "researchHash":hex(&c.research_hash),"giftHash":hex(&c.gift_hash),"podHash":hex(&c.pod_hash),"specHash":hex(&c.spec_hash),"quoteHash":hex(&c.quote_hash),
        "merchantHash":hex(&c.merchant_hash),"paymentAttemptHash":hex(&c.payment_attempt_hash),"paymentAuthHash":hex(&c.payment_auth_hash),"purchaseHash":hex(&c.purchase_hash),
        "orderIdHash":hex(&c.order_id_hash),"fulfillmentHash":hex(&c.fulfillment_hash),"quoteVersion":c.quote_version,"jobKind":c.job_kind,"adapter":c.adapter,
        "currency":String::from_utf8_lossy(&c.currency),"currencyExponent":c.currency_exponent,"chargeCurrency":String::from_utf8_lossy(&c.charge_currency),"chargeCurrencyExponent":c.charge_currency_exponent,
        "itemSubtotalMinor":c.item_subtotal_minor.to_string(),"smallOrderFeeMinor":c.small_order_fee_minor.to_string(),"serviceFeeMinor":c.service_fee_minor.to_string(),
        "deliveryFeeMinor":c.delivery_fee_minor.to_string(),"tipMinor":c.tip_minor.to_string(),"otherFeesMinor":c.other_fees_minor.to_string(),"landedTotalMinor":c.landed_total_minor.to_string(),
        "maxTotalMinor":c.max_total_minor.to_string(),"settlementAmount":c.settlement_amount.to_string(),"quotedChargeAmountMinor":c.quoted_charge_amount_minor.to_string(),
        "settlementUnitsPerChargeUnitMicros":c.settlement_units_per_charge_unit_micros.to_string(),"authenticatedAmountMinor":c.authenticated_amount_minor.to_string(),
        "chargedAmountMinor":c.charged_amount_minor.to_string(),"quoteCapturedAt":c.quote_captured_at.to_string(),"quoteExpiresAt":c.quote_expires_at.to_string(),
        "paymentAttemptedAt":c.payment_attempted_at.to_string(),"paymentAuthenticatedAt":c.payment_authenticated_at.to_string(),"purchasedAt":c.purchased_at.to_string(),
        "createdAt":c.created_at.to_string(),"expiresAt":c.expires_at.to_string(),"status":format!("{:?}",c.status),"vaultBump":c.vault_bump,"bump":c.bump})
}
fn mandate_json(m: &Mandate) -> Value {
    json!({"campaign":m.campaign.to_string(),"sender":m.sender.to_string(),"executor":m.executor.to_string(),"merchantHash":hex(&m.merchant_hash),
        "specHash":hex(&m.spec_hash),"recipientHash":hex(&m.recipient_hash),"chargeCurrency":String::from_utf8_lossy(&m.charge_currency),
        "chargeCurrencyExponent":m.charge_currency_exponent,"maxChargeAmountMinor":m.max_charge_amount_minor.to_string(),"maxEscrowDebit":m.max_escrow_debit.to_string(),
        "expiresAt":m.expires_at.to_string(),"status":format!("{:?}",m.status),"approvedTermsHash":hex(&m.approved_terms_hash),"consumedAt":m.consumed_at.to_string(),"bump":m.bump})
}
fn canonical_bytes(
    campaign_key: Pubkey,
    mandate_key: Pubkey,
    c: &Campaign,
    m: &Mandate,
    cfg: &Config,
) -> Vec<u8> {
    let mut b = b"gift-campaign:mandate-quote:v1".to_vec();
    for k in [
        gift_campaign::ID,
        campaign_key,
        mandate_key,
        cfg.allowed_mint,
        m.campaign,
        m.sender,
        m.executor,
    ] {
        b.extend_from_slice(k.as_ref());
    }
    b.extend_from_slice(&cfg.fee_bps.to_le_bytes());
    for h in [&m.merchant_hash, &m.spec_hash, &m.recipient_hash] {
        b.extend_from_slice(h);
    }
    b.extend_from_slice(&m.charge_currency);
    b.push(m.charge_currency_exponent);
    b.extend_from_slice(&m.max_charge_amount_minor.to_le_bytes());
    b.extend_from_slice(&m.max_escrow_debit.to_le_bytes());
    b.extend_from_slice(&m.expires_at.to_le_bytes());
    b.extend_from_slice(&c.quote_version.to_le_bytes());
    b.extend_from_slice(&[c.job_kind, c.adapter]);
    for h in [&c.spec_hash, &c.quote_hash, &c.merchant_hash] {
        b.extend_from_slice(h);
    }
    b.extend_from_slice(&c.currency);
    b.push(c.currency_exponent);
    b.extend_from_slice(&c.charge_currency);
    b.push(c.charge_currency_exponent);
    for v in [
        c.item_subtotal_minor,
        c.small_order_fee_minor,
        c.service_fee_minor,
        c.delivery_fee_minor,
        c.tip_minor,
        c.other_fees_minor,
        c.landed_total_minor,
        c.max_total_minor,
        c.settlement_amount,
        c.quoted_charge_amount_minor,
        c.settlement_units_per_charge_unit_micros,
    ] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    for v in [c.quote_captured_at, c.quote_expires_at, c.expires_at] {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

fn main() {
    // A dependency panic cannot emit a misleading success or terminate the JSONL protocol.
    std::panic::set_hook(Box::new(|_| {}));
    let mut bridge = match std::panic::catch_unwind(Bridge::new) {
        Ok(v) => v,
        Err(_) => Err("bridge_initialization_internal_failure".into()),
    };
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let mut output = io::BufWriter::new(io::stdout().lock());
    loop {
        // Bounded allocation, with oversized lines drained through their delimiter.
        let mut bytes = Vec::new();
        let mut oversized = false;
        let mut saw_any = false;
        let read = loop {
            match input.fill_buf() {
                Err(e) => break Err(e.to_string()),
                Ok([]) => break Ok(saw_any),
                Ok(chunk) => {
                    let end = chunk.iter().position(|v| *v == b'\n').map(|i| i + 1);
                    let n = end.unwrap_or(chunk.len());
                    saw_any = true;
                    if bytes.len() + n <= MAX_LINE {
                        bytes.extend_from_slice(&chunk[..n]);
                    } else {
                        oversized = true;
                    }
                    input.consume(n);
                    if end.is_some() {
                        break Ok(true);
                    }
                }
            }
        };
        if matches!(read, Ok(false)) {
            break;
        }
        let mut txs = Vec::new();
        let parsed: Result<Command> = if oversized {
            Err("command_line_too_large".into())
        } else if let Err(e) = read.as_ref() {
            Err(format!("stdin_read_failed:{e}"))
        } else {
            serde_json::from_slice(&bytes).map_err(|e| format!("invalid_command:{e}"))
        };
        let response = match bridge.as_mut() {
            Err(error) => {
                json!({"accepted":false,"error":{"code":"bridge_initialization_failed","detail":error},"backend":"LiteSVM local Solana",
                "ephemeralDemoSigners":true,"network":"none","realFunds":false,"transactions":[],"state":null,"canonical":null,"publicKeys":null,"binarySha256":null})
            }
            Ok(b) => {
                let result = match parsed {
                    Err(e) => Err(e),
                    Ok(cmd) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        b.dispatch(cmd, &mut txs)
                    })) {
                        Ok(v) => v,
                        Err(_) => {
                            b.poisoned = true;
                            Err("bridge_internal_failure_reconcile_state".into())
                        }
                    },
                };
                b.response(result, txs)
            }
        };
        if serde_json::to_writer(&mut output, &response).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            break;
        }
        if read.is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn quote(expires_at: i64) -> Quote {
        Quote {
            merchant_hash: "11".repeat(32),
            spec_hash: "22".repeat(32),
            recipient_hash: "33".repeat(32),
            quote_hash: "44".repeat(32),
            currency: "PLN".into(),
            currency_exponent: 2,
            total_minor: 12_900,
            expires_at,
        }
    }
    #[test]
    fn sbf_exact_authorization_is_atomic_and_attempt_is_one_use() {
        let mut b = Bridge::new().expect("cached SBF loads");
        let mut txs = vec![];
        b.prepare(quote(now().unwrap() + 600), &mut txs).unwrap();
        assert!(b.decode::<Mandate>(b.mandate).unwrap().is_none());
        let canonical = b.canonical().unwrap().unwrap();
        let terms = hash32(canonical["termsHash"].as_str().unwrap()).unwrap();
        assert_eq!(
            b.campaign_state().unwrap().status,
            gift_campaign::state::CampaignStatus::Quoted
        );
        let bad = b.authorize([255; 32], &mut txs);
        assert!(bad.is_err());
        assert!(txs.last().unwrap()["logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains("TermsMismatch")));
        assert!(b.decode::<Mandate>(b.mandate).unwrap().is_none());
        b.authorize(terms, &mut txs).unwrap();
        b.attempt(terms, [55; 32], &mut txs).unwrap();
        let accepted_signature = txs.last().unwrap()["signature"].clone();
        assert!(b.attempt(terms, [55; 32], &mut txs).is_err());
        assert_ne!(accepted_signature, txs.last().unwrap()["signature"]);
        assert!(txs.last().unwrap()["logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains("InvalidCampaignState")));
        assert_eq!(
            b.decode::<Mandate>(b.mandate).unwrap().unwrap().status,
            MandateStatus::Consumed
        );
        // Receipt failure rolls back authentication too, leaving the previous state recoverable.
        assert!(b.confirm([0; 32], [77; 32], &mut txs).is_err());
        assert_eq!(
            b.campaign_state().unwrap().status,
            gift_campaign::state::CampaignStatus::PaymentAttempted
        );
        b.confirm([66; 32], [77; 32], &mut txs).unwrap();
        let c = b.campaign_state().unwrap();
        assert_eq!(c.status, gift_campaign::state::CampaignStatus::Purchased);
        assert_eq!(c.charged_amount_minor, 12_900);
        assert_eq!(
            b.canonical().unwrap().unwrap()["termsHash"],
            canonical["termsHash"]
        );
        assert_eq!(b.token_balance(b.vault), Some("129000000".into()));
    }
    #[test]
    fn expired_mandate_rejection_comes_from_sbf_with_unchanged_authorization() {
        let mut b = Bridge::new().unwrap();
        let mut txs = vec![];
        let expiry = now().unwrap() + 3;
        b.prepare(quote(expiry), &mut txs).unwrap();
        let canonical = b.canonical().unwrap().unwrap();
        let terms = hash32(canonical["termsHash"].as_str().unwrap()).unwrap();
        b.authorize(terms, &mut txs).unwrap();
        while now().unwrap() < expiry {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(b.attempt(terms, [88; 32], &mut txs).is_err());
        assert!(txs.last().unwrap()["logs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v.as_str().unwrap().contains("MandateExpired")));
        assert_eq!(
            b.decode::<Mandate>(b.mandate).unwrap().unwrap().status,
            MandateStatus::Active
        );
        assert_eq!(
            b.campaign_state().unwrap().status,
            gift_campaign::state::CampaignStatus::Approved
        );
    }
    #[test]
    fn command_schema_rejects_unknown_fields_and_keeps_hash_parser_bounded() {
        assert!(serde_json::from_value::<Command>(json!({"op":"state","extra":true})).is_err());
        assert!(serde_json::from_value::<Command>(
            json!({"op":"authorize","termsHash":"00".repeat(32),"termsHash2":"secret"})
        )
        .is_err());
        assert!(hash32(&"é".repeat(32)).is_err());
        assert!(hash32("ab").is_err());
        assert_eq!(hash32(&"AB".repeat(32)).unwrap(), [171; 32]);
    }
}
