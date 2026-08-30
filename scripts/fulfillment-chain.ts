import * as anchor from "@anchor-lang/core";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { GiftCampaign } from "../target/types/gift_campaign";

const REPO_ROOT = resolve(__dirname, "..");
const AGENT_OUT = resolve(REPO_ROOT, "agent/out");
const IDL_PATH = resolve(REPO_ROOT, "target/idl/gift_campaign.json");
const QUOTE_PATH = resolve(AGENT_OUT, "quote.json");
const OBSERVATION_PATH = resolve(AGENT_OUT, "mcp-browser-observation.json");
const CHAIN_JOB_PATH = resolve(AGENT_OUT, "chain-job.json");
const DEMO_DIR = resolve(REPO_ROOT, ".demo");
const SENDER_WALLET = resolve(DEMO_DIR, "payer.json");
const RESEARCH_WALLET = resolve(DEMO_DIR, "research-oracle.json");
const FULFILLMENT_WALLET = resolve(DEMO_DIR, "fulfillment-oracle.json");
const TREASURY_WALLET = resolve(DEMO_DIR, "treasury.json");
const DEVNET_REPLAY_PATH = resolve(DEMO_DIR, "devnet-replay.json");
const RPC_URL = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const FEE_BPS = 500;
const TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ASSOCIATED_TOKEN_PROGRAM_ID = new anchor.web3.PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

interface QuoteFile {
  job_kind: "food" | "merch" | "handmade" | "generic";
  adapter:
    "wolt" | "glovo" | "pyszne" | "local_print" | "local_shop" | "manual";
  landed_pln: number | null;
  max_pln: number;
  spec_hash: string;
  currency: string;
  currency_exponent: number;
  charge_currency: string | null;
  charge_currency_exponent: number | null;
  charge_amount: number | null;
  settlement_units_per_charge_unit?: number | null;
  pln_per_charge_unit: number | null;
  captured_at: string;
  breakdown_pln?: {
    item_subtotal: number;
    small_order_fee: number;
    service_fee: number;
    delivery_fee: number;
    tip: number;
    other_fees: number;
  };
  source_url: string | null;
}

interface ChainQuote {
  version: 1;
  job_kind: number;
  adapter: number;
  spec_hash: string;
  merchant: string;
  currency: string;
  currency_exponent: number;
  charge_currency: string;
  charge_currency_exponent: number;
  item_subtotal_minor: number;
  small_order_fee_minor: number;
  service_fee_minor: number;
  delivery_fee_minor: number;
  tip_minor: number;
  other_fees_minor: number;
  landed_total_minor: number;
  max_total_minor: number;
  settlement_amount: number;
  quoted_charge_amount_minor: number;
  settlement_units_per_charge_unit_micros: number;
  captured_at: number;
  expires_at: number;
}

interface ChainJob {
  campaign: string;
  vault: string;
  mint: string;
  sender_token: string;
  treasury_token: string;
  operator_token: string;
  quote_hash: string;
  spec_hash: string;
  quote_version: 1;
  currency: string;
  currency_exponent: number;
  charge_currency: string;
  charge_currency_exponent: number;
  landed_total_minor: number;
  max_total_minor: number;
  settlement_amount: number;
  quoted_charge_amount_minor: number;
  settlement_units_per_charge_unit_micros: number;
  status: string;
  transactions: Record<string, string>;
}

function makeChainJob(
  chainQuote: ChainQuote,
  hash: string,
  addresses: {
    campaign: anchor.web3.PublicKey;
    vault: anchor.web3.PublicKey;
    mint: anchor.web3.PublicKey;
    senderToken: anchor.web3.PublicKey;
    treasuryToken: anchor.web3.PublicKey;
    operatorToken: anchor.web3.PublicKey;
  },
  status: string,
  transactions: Record<string, string>,
): ChainJob {
  return {
    campaign: addresses.campaign.toBase58(),
    vault: addresses.vault.toBase58(),
    mint: addresses.mint.toBase58(),
    sender_token: addresses.senderToken.toBase58(),
    treasury_token: addresses.treasuryToken.toBase58(),
    operator_token: addresses.operatorToken.toBase58(),
    quote_hash: hash,
    spec_hash: chainQuote.spec_hash,
    quote_version: 1,
    currency: chainQuote.currency,
    currency_exponent: chainQuote.currency_exponent,
    charge_currency: chainQuote.charge_currency,
    charge_currency_exponent: chainQuote.charge_currency_exponent,
    landed_total_minor: chainQuote.landed_total_minor,
    max_total_minor: chainQuote.max_total_minor,
    settlement_amount: chainQuote.settlement_amount,
    quoted_charge_amount_minor: chainQuote.quoted_charge_amount_minor,
    settlement_units_per_charge_unit_micros:
      chainQuote.settlement_units_per_charge_unit_micros,
    status,
    transactions,
  };
}

// The frozen Anchor program has four adapter slots. Slot 0 represents the
// last-mile food marketplace class; the exact marketplace is additionally
// bound into the on-chain merchant hash below.
const CHAIN_ADAPTER_CODE: Record<QuoteFile["adapter"], number> = {
  wolt: 0,
  glovo: 0,
  pyszne: 0,
  local_print: 1,
  local_shop: 2,
  manual: 3,
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(hex: string): number[] {
  if (!/^[a-f0-9]{64}$/i.test(hex))
    throw new Error("expected a SHA-256 hex value");
  return [...Buffer.from(hex, "hex")];
}

function currencyBytes(currency: string): number[] {
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error("currency must be three uppercase letters");
  return [...Buffer.from(currency, "ascii")];
}

function formatMinor(
  amount: number,
  exponent: number,
  currency: string,
): string {
  return `${(amount / 10 ** exponent).toFixed(exponent)} ${currency}`;
}

function toMinor(value: number, label: string, exponent = 2): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} is invalid`);
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw new Error(`${label} currency exponent is invalid`);
  }
  const scale = 10 ** exponent;
  const minor = Math.round(value * scale);
  if (Math.abs(minor / scale - value) > 0.000_001) {
    throw new Error(`${label} has more decimals than its currency exponent`);
  }
  return minor;
}

function buildChainQuote(replayAt?: number): ChainQuote {
  const quote = readJson<QuoteFile>(QUOTE_PATH);
  const settlementRate =
    quote.settlement_units_per_charge_unit ?? quote.pln_per_charge_unit;
  if (!/^[A-Z]{3}$/.test(quote.currency) || quote.landed_pln === null) {
    throw new Error(
      "quote.json must contain an exact landed amount and currency",
    );
  }
  if (
    quote.charge_currency === null ||
    !/^[A-Z]{3}$/.test(quote.charge_currency) ||
    quote.charge_currency_exponent === null ||
    quote.charge_amount === null ||
    settlementRate === null ||
    settlementRate <= 0
  ) {
    throw new Error(
      "quote.json must contain an exact card currency, amount, and settlement conversion",
    );
  }
  if (!/^[a-f0-9]{64}$/i.test(quote.spec_hash)) {
    throw new Error("quote.json spec_hash is invalid");
  }
  const captured = new Date(quote.captured_at);
  if (Number.isNaN(captured.valueOf()))
    throw new Error("quote captured_at is invalid");
  const capturedAt = Math.floor(captured.valueOf() / 1_000);
  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = replayAt ? replayAt + 30 * 60 : capturedAt + 30 * 60;
  if (!replayAt && now > expiresAt) {
    throw new Error(
      "quote.json is older than 30 minutes; create a fresh final checkout quote",
    );
  }
  const observed = existsSync(OBSERVATION_PATH)
    ? readJson<{ merchant?: string }>(OBSERVATION_PATH)
    : {};
  const merchantName =
    observed.merchant?.trim() ||
    (quote.source_url ? new URL(quote.source_url).hostname : "manual merchant");
  const adapterPrefix = `${quote.adapter}:`;
  const merchant = merchantName
    .toLocaleLowerCase()
    .startsWith(adapterPrefix.toLocaleLowerCase())
    ? merchantName
    : `${adapterPrefix}${merchantName}`;
  const total = toMinor(
    quote.landed_pln,
    "landed amount",
    quote.currency_exponent,
  );
  const breakdown = quote.breakdown_pln ?? {
    item_subtotal: quote.landed_pln,
    small_order_fee: 0,
    service_fee: 0,
    delivery_fee: 0,
    tip: 0,
    other_fees: 0,
  };
  const chainQuote: ChainQuote = {
    version: 1,
    job_kind: ["food", "merch", "handmade", "generic"].indexOf(quote.job_kind),
    adapter: CHAIN_ADAPTER_CODE[quote.adapter],
    spec_hash: quote.spec_hash.toLowerCase(),
    merchant,
    currency: quote.currency,
    currency_exponent: quote.currency_exponent,
    charge_currency: quote.charge_currency,
    charge_currency_exponent: quote.charge_currency_exponent,
    item_subtotal_minor: toMinor(
      breakdown.item_subtotal,
      "item subtotal",
      quote.currency_exponent,
    ),
    small_order_fee_minor: toMinor(
      breakdown.small_order_fee,
      "small-order fee",
      quote.currency_exponent,
    ),
    service_fee_minor: toMinor(
      breakdown.service_fee,
      "service fee",
      quote.currency_exponent,
    ),
    delivery_fee_minor: toMinor(
      breakdown.delivery_fee,
      "delivery fee",
      quote.currency_exponent,
    ),
    tip_minor: toMinor(breakdown.tip, "tip", quote.currency_exponent),
    other_fees_minor: toMinor(
      breakdown.other_fees,
      "other fees",
      quote.currency_exponent,
    ),
    landed_total_minor: total,
    max_total_minor: toMinor(
      quote.max_pln,
      "configured maximum",
      quote.currency_exponent,
    ),
    settlement_amount: total,
    quoted_charge_amount_minor: toMinor(
      quote.charge_amount,
      "card charge amount",
      quote.charge_currency_exponent,
    ),
    settlement_units_per_charge_unit_micros: Math.round(
      settlementRate * 1_000_000,
    ),
    captured_at: capturedAt,
    // Normal runs derive expiry from capture time for stable verification.
    // A devnet evidence replay gets a fresh submission window while retaining
    // the original capture timestamp and exact quote-artifact hash.
    expires_at: expiresAt,
  };
  const sum =
    chainQuote.item_subtotal_minor +
    chainQuote.small_order_fee_minor +
    chainQuote.service_fee_minor +
    chainQuote.delivery_fee_minor +
    chainQuote.tip_minor +
    chainQuote.other_fees_minor;
  if (sum !== total)
    throw new Error("quote fee components do not equal landed total");
  if (
    Math.abs(quote.charge_amount * settlementRate - quote.landed_pln) >
    1 / 10 ** quote.currency_exponent
  ) {
    throw new Error(
      "card amount and conversion do not reproduce the landed settlement amount",
    );
  }
  if (chainQuote.job_kind < 0 || chainQuote.adapter < 0) {
    throw new Error("unsupported job kind or adapter");
  }
  if (chainQuote.settlement_units_per_charge_unit_micros <= 0) {
    throw new Error("settlement conversion rate is invalid");
  }
  return chainQuote;
}

interface DevnetReplayArtifact {
  cluster: "devnet";
  program: string;
  campaign: string;
  vault: string;
  mint: string;
  status: string;
  hashes: Record<string, string>;
  transactions: Record<string, string>;
  recorded_at: string;
}

function explorerTransaction(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

async function replayDevnet(): Promise<void> {
  if (!RPC_URL.toLowerCase().includes("devnet")) {
    throw new Error("replay-devnet requires a devnet ANCHOR_PROVIDER_URL");
  }
  if (process.env.DEVNET_REPLAY_CONFIRM !== "RECORD_SURFPOOL_EVIDENCE") {
    throw new Error(
      "set DEVNET_REPLAY_CONFIRM=RECORD_SURFPOOL_EVIDENCE to authorize devnet writes",
    );
  }

  const requiredPaths = [
    QUOTE_PATH,
    resolve(AGENT_OUT, "payment-attempt.json"),
    resolve(AGENT_OUT, "payment-auth.json"),
    resolve(AGENT_OUT, "purchase.json"),
    resolve(AGENT_OUT, "delivery-evidence.json"),
    resolve(AGENT_OUT, "fulfillment.json"),
  ];
  for (const path of requiredPaths) {
    if (!existsSync(path))
      throw new Error(`required replay artifact is missing: ${path}`);
  }
  for (const path of [
    SENDER_WALLET,
    RESEARCH_WALLET,
    FULFILLMENT_WALLET,
    TREASURY_WALLET,
  ]) {
    if (!existsSync(path))
      throw new Error(`required demo wallet is missing: ${path}`);
  }

  const provider = providerFor(SENDER_WALLET);
  const program = programFor(provider);
  const sender = provider.wallet.publicKey;
  const research = loadKeypair(RESEARCH_WALLET);
  const fulfillment = loadKeypair(FULFILLMENT_WALLET);
  const treasury = loadKeypair(TREASURY_WALLET);

  if (existsSync(DEVNET_REPLAY_PATH)) {
    const previous = readJson<DevnetReplayArtifact>(DEVNET_REPLAY_PATH);
    if (
      previous.cluster === "devnet" &&
      previous.program === program.programId.toBase58()
    ) {
      const account = await provider.connection.getAccountInfo(
        new anchor.web3.PublicKey(previous.campaign),
      );
      if (account) {
        const state = await program.account.campaign.fetch(
          new anchor.web3.PublicKey(previous.campaign),
        );
        const status = statusName(
          state.status as unknown as Record<string, unknown>,
        );
        if (status === "settled") {
          chainResult({ ...previous, status, already_recorded: true });
          return;
        }
      }
    }
  }

  const replayAt = Math.floor(Date.now() / 1_000);
  const chainQuote = buildChainQuote(replayAt);
  const quoteArtifact = readJson<unknown>(QUOTE_PATH);
  const paymentAttemptPath = resolve(AGENT_OUT, "payment-attempt.json");
  const paymentAuthPath = resolve(AGENT_OUT, "payment-auth.json");
  const purchasePath = resolve(AGENT_OUT, "purchase.json");
  const deliveryEvidencePath = resolve(AGENT_OUT, "delivery-evidence.json");
  const fulfillmentPath = resolve(AGENT_OUT, "fulfillment.json");
  const paymentAttempt = readJson<{ quote_sha256: string }>(paymentAttemptPath);
  const paymentAuth = readJson<{ currency: string; amount_minor: number }>(
    paymentAuthPath,
  );
  const purchase = readJson<{
    currency: string;
    amount_minor: number;
    order_id: string;
  }>(purchasePath);
  const deliveryEvidence = readJson<{ screenshot_path?: string }>(
    deliveryEvidencePath,
  );

  const quoteArtifactHash = sha256(canonicalize(quoteArtifact));
  if (paymentAttempt.quote_sha256 !== quoteArtifactHash) {
    throw new Error(
      "payment attempt does not reference the exact current quote artifact",
    );
  }
  if (
    paymentAuth.currency !== chainQuote.charge_currency ||
    paymentAuth.amount_minor !== chainQuote.quoted_charge_amount_minor ||
    purchase.currency !== chainQuote.charge_currency ||
    purchase.amount_minor !== chainQuote.quoted_charge_amount_minor
  ) {
    throw new Error(
      "payment authentication or purchase amount does not match the quote",
    );
  }

  const paymentAttemptHash = sha256(
    canonicalize(readJson<unknown>(paymentAttemptPath)),
  );
  const paymentAuthHash = sha256(canonicalize(paymentAuth));
  const purchaseHash = sha256(canonicalize(purchase));
  const orderIdHash = sha256(purchase.order_id);
  const fulfillmentHash = sha256(
    canonicalize(readJson<unknown>(fulfillmentPath)),
  );
  const proofPath = deliveryEvidence.screenshot_path
    ? resolve(REPO_ROOT, deliveryEvidence.screenshot_path)
    : deliveryEvidencePath;
  if (!existsSync(proofPath)) {
    throw new Error(`delivery proof is missing: ${proofPath}`);
  }
  const proofHash = sha256(readFileSync(proofPath));

  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const existingConfigInfo = await provider.connection.getAccountInfo(config);

  // Recover a replay that reached the public chain but was interrupted before
  // its local receipt was written (for example, by public RPC throttling).
  if (existingConfigInfo) {
    const existing = await program.account.config.fetch(config);
    if (
      !existing.authority.equals(sender) ||
      !existing.treasury.equals(treasury.publicKey) ||
      !existing.researchOracle.equals(research.publicKey) ||
      !existing.deliveryOracle.equals(fulfillment.publicKey) ||
      existing.feeBps !== FEE_BPS
    ) {
      throw new Error(
        "existing devnet Config is incompatible with the Surfpool actors",
      );
    }
    const matchingCampaigns = (await program.account.campaign.all()).filter(
      ({ account }) =>
        account.sender.equals(sender) &&
        Buffer.from(account.quoteHash).toString("hex") === quoteArtifactHash,
    );
    if (matchingCampaigns.length > 1) {
      throw new Error(
        `found ${matchingCampaigns.length} matching devnet replays; refusing to guess`,
      );
    }
    if (matchingCampaigns.length === 1) {
      const campaign = matchingCampaigns[0].publicKey;
      const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), campaign.toBuffer()],
        program.programId,
      );
      const mint = existing.allowedMint;
      const senderToken = associatedTokenAddress(sender, mint);
      const treasuryToken = associatedTokenAddress(treasury.publicKey, mint);
      const operatorToken = associatedTokenAddress(fulfillment.publicKey, mint);
      let status = statusName(
        matchingCampaigns[0].account.status as unknown as Record<
          string,
          unknown
        >,
      );
      let settleSignature: string | null = null;
      if (status === "purchased") {
        settleSignature = await program.methods
          .settleFulfillment(hashBytes(proofHash), hashBytes(fulfillmentHash))
          .accountsPartial({
            config,
            campaign,
            vault,
            senderToken,
            treasuryToken,
            operatorToken,
            fulfillmentOracle: fulfillment.publicKey,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([fulfillment])
          .rpc();
        status = "settled";
      }
      if (status !== "settled") {
        throw new Error(
          `matching interrupted replay is ${status}; automatic recovery supports purchased or settled`,
        );
      }

      const history = (
        await provider.connection.getSignaturesForAddress(campaign, {
          limit: 10,
        })
      ).reverse();
      const lifecycleNames = [
        "create",
        "quote",
        "approve",
        "paymentAttempt",
        "paymentAuth",
        "purchase",
        "settle",
      ];
      const transactions = Object.fromEntries(
        history
          .slice(0, lifecycleNames.length)
          .map(({ signature }, index) => [lifecycleNames[index], signature]),
      );
      if (settleSignature) transactions.settle = settleSignature;
      const artifact: DevnetReplayArtifact = {
        cluster: "devnet",
        program: program.programId.toBase58(),
        campaign: campaign.toBase58(),
        vault: vault.toBase58(),
        mint: mint.toBase58(),
        status,
        hashes: {
          quote: quoteArtifactHash,
          spec: chainQuote.spec_hash,
          payment_attempt: paymentAttemptHash,
          payment_auth: paymentAuthHash,
          purchase: purchaseHash,
          order_id: orderIdHash,
          delivery_proof: proofHash,
          fulfillment: fulfillmentHash,
        },
        transactions,
        recorded_at: new Date().toISOString(),
      };
      writePrivateJson(DEVNET_REPLAY_PATH, artifact);
      chainResult({
        ...artifact,
        recovered: true,
        explorer: Object.fromEntries(
          Object.entries(transactions).map(([key, signature]) => [
            key,
            explorerTransaction(signature),
          ]),
        ),
      });
      return;
    }
  }

  let mint: anchor.web3.PublicKey;
  let initializeSignature: string | null = null;
  if (existingConfigInfo) {
    const existing = await program.account.config.fetch(config);
    if (
      !existing.authority.equals(sender) ||
      !existing.treasury.equals(treasury.publicKey) ||
      !existing.researchOracle.equals(research.publicKey) ||
      !existing.deliveryOracle.equals(fulfillment.publicKey) ||
      existing.feeBps !== FEE_BPS
    ) {
      throw new Error(
        "existing devnet Config is incompatible with the Surfpool actors",
      );
    }
    mint = existing.allowedMint;
  } else {
    mint = new anchor.web3.PublicKey(
      findAddress(
        tokenCli([
          "create-token",
          "--fee-payer",
          SENDER_WALLET,
          "--mint-authority",
          sender.toBase58(),
          "--decimals",
          String(chainQuote.currency_exponent),
        ]),
      ),
    );
  }

  const senderToken = await ensureAssociatedTokenAccount(
    provider.connection,
    sender,
    mint,
  );
  const treasuryToken = await ensureAssociatedTokenAccount(
    provider.connection,
    treasury.publicKey,
    mint,
  );
  const operatorToken = await ensureAssociatedTokenAccount(
    provider.connection,
    fulfillment.publicKey,
    mint,
  );
  const maximumFee = Math.floor(
    (chainQuote.max_total_minor * FEE_BPS) / 10_000,
  );
  const budget = chainQuote.max_total_minor + maximumFee;
  tokenCli([
    "mint",
    "--fee-payer",
    SENDER_WALLET,
    "--mint-authority",
    SENDER_WALLET,
    mint.toBase58(),
    (budget / 10 ** chainQuote.currency_exponent).toFixed(
      chainQuote.currency_exponent,
    ),
    senderToken.toBase58(),
  ]);

  if (!existingConfigInfo) {
    initializeSignature = await program.methods
      .initialize(FEE_BPS)
      .accountsPartial({
        config,
        authority: sender,
        treasury: treasury.publicKey,
        researchOracle: research.publicKey,
        deliveryOracle: fulfillment.publicKey,
        allowedMint: mint,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  }

  const nonce = new anchor.BN(Date.now());
  const [campaign] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("campaign"),
      sender.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), campaign.toBuffer()],
    program.programId,
  );
  const campaignExpiry = new anchor.BN(replayAt + 24 * 60 * 60);
  const transactions: Record<string, string> = {};
  if (initializeSignature) transactions.initialize = initializeSignature;

  transactions.create = await program.methods
    .createCampaign(nonce, new anchor.BN(budget), campaignExpiry)
    .accountsPartial({
      config,
      campaign,
      vault,
      sender,
      senderToken,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  transactions.quote = await program.methods
    .submitQuote(
      1,
      chainQuote.job_kind,
      chainQuote.adapter,
      hashBytes(chainQuote.spec_hash),
      hashBytes(quoteArtifactHash),
      hashBytes(sha256(chainQuote.merchant)),
      currencyBytes(chainQuote.currency),
      chainQuote.currency_exponent,
      currencyBytes(chainQuote.charge_currency),
      chainQuote.charge_currency_exponent,
      new anchor.BN(chainQuote.item_subtotal_minor),
      new anchor.BN(chainQuote.small_order_fee_minor),
      new anchor.BN(chainQuote.service_fee_minor),
      new anchor.BN(chainQuote.delivery_fee_minor),
      new anchor.BN(chainQuote.tip_minor),
      new anchor.BN(chainQuote.other_fees_minor),
      new anchor.BN(chainQuote.landed_total_minor),
      new anchor.BN(chainQuote.max_total_minor),
      new anchor.BN(chainQuote.settlement_amount),
      new anchor.BN(chainQuote.quoted_charge_amount_minor),
      new anchor.BN(chainQuote.settlement_units_per_charge_unit_micros),
      new anchor.BN(chainQuote.captured_at),
      new anchor.BN(chainQuote.expires_at),
    )
    .accountsPartial({ config, campaign, researchOracle: research.publicKey })
    .signers([research])
    .rpc();
  transactions.approve = await program.methods
    .approveQuote(1, hashBytes(quoteArtifactHash))
    .accountsPartial({ campaign, sender })
    .rpc();
  transactions.paymentAttempt = await program.methods
    .recordPaymentAttempt(
      1,
      hashBytes(quoteArtifactHash),
      hashBytes(paymentAttemptHash),
    )
    .accountsPartial({
      config,
      campaign,
      fulfillmentOracle: fulfillment.publicKey,
    })
    .signers([fulfillment])
    .rpc();
  transactions.paymentAuth = await program.methods
    .recordPaymentAuth(
      hashBytes(paymentAuthHash),
      currencyBytes(paymentAuth.currency),
      new anchor.BN(paymentAuth.amount_minor),
    )
    .accountsPartial({
      config,
      campaign,
      fulfillmentOracle: fulfillment.publicKey,
    })
    .signers([fulfillment])
    .rpc();
  transactions.purchase = await program.methods
    .recordPurchase(
      hashBytes(purchaseHash),
      hashBytes(orderIdHash),
      currencyBytes(purchase.currency),
      new anchor.BN(purchase.amount_minor),
    )
    .accountsPartial({
      config,
      campaign,
      fulfillmentOracle: fulfillment.publicKey,
    })
    .signers([fulfillment])
    .rpc();
  transactions.settle = await program.methods
    .settleFulfillment(hashBytes(proofHash), hashBytes(fulfillmentHash))
    .accountsPartial({
      config,
      campaign,
      vault,
      senderToken,
      treasuryToken,
      operatorToken,
      fulfillmentOracle: fulfillment.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([fulfillment])
    .rpc();

  const state = await program.account.campaign.fetch(campaign);
  const status = statusName(state.status as unknown as Record<string, unknown>);
  if (status !== "settled") {
    throw new Error(`devnet replay ended in unexpected state: ${status}`);
  }
  const artifact: DevnetReplayArtifact = {
    cluster: "devnet",
    program: program.programId.toBase58(),
    campaign: campaign.toBase58(),
    vault: vault.toBase58(),
    mint: mint.toBase58(),
    status,
    hashes: {
      quote: quoteArtifactHash,
      spec: chainQuote.spec_hash,
      payment_attempt: paymentAttemptHash,
      payment_auth: paymentAuthHash,
      purchase: purchaseHash,
      order_id: orderIdHash,
      delivery_proof: proofHash,
      fulfillment: fulfillmentHash,
    },
    transactions,
    recorded_at: new Date().toISOString(),
  };
  writePrivateJson(DEVNET_REPLAY_PATH, artifact);
  chainResult({
    ...artifact,
    explorer: Object.fromEntries(
      Object.entries(transactions).map(([key, signature]) => [
        key,
        explorerTransaction(signature),
      ]),
    ),
  });
}

function quoteHash(quote: ChainQuote): string {
  return sha256(canonicalize(quote));
}

function ensureKeypair(path: string): anchor.web3.Keypair {
  if (existsSync(path)) {
    return anchor.web3.Keypair.fromSecretKey(
      Uint8Array.from(readJson<number[]>(path)),
    );
  }
  const keypair = anchor.web3.Keypair.generate();
  writePrivateJson(path, [...keypair.secretKey]);
  return keypair;
}

function loadKeypair(path: string): anchor.web3.Keypair {
  if (!existsSync(path)) throw new Error(`wallet does not exist: ${path}`);
  return anchor.web3.Keypair.fromSecretKey(
    Uint8Array.from(readJson<number[]>(path)),
  );
}

function providerFor(walletPath: string): anchor.AnchorProvider {
  const keypair = loadKeypair(walletPath);
  const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
  return new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), {
    commitment: "confirmed",
  });
}

function programFor(
  provider: anchor.AnchorProvider,
): anchor.Program<GiftCampaign> {
  const idl = readJson<anchor.Idl>(IDL_PATH);
  return new anchor.Program(idl, provider) as anchor.Program<GiftCampaign>;
}

function tokenCli(args: string[]): unknown {
  return JSON.parse(
    execFileSync("spl-token", ["--url", RPC_URL, "--output", "json", ...args], {
      encoding: "utf8",
      cwd: REPO_ROOT,
    }),
  ) as unknown;
}

function findAddress(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.address === "string") return record.address;
    for (const child of Object.values(record)) {
      try {
        return findAddress(child);
      } catch {
        // Continue until an address is found.
      }
    }
  }
  throw new Error("SPL Token output did not contain an address");
}

function associatedTokenAddress(
  owner: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey,
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

async function fundWallet(
  connection: anchor.web3.Connection,
  recipient: anchor.web3.PublicKey,
): Promise<void> {
  const signature = await connection.requestAirdrop(
    recipient,
    2 * anchor.web3.LAMPORTS_PER_SOL,
  );
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
}

async function ensureAssociatedTokenAccount(
  connection: anchor.web3.Connection,
  owner: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey,
): Promise<anchor.web3.PublicKey> {
  const address = associatedTokenAddress(owner, mint);
  if (!(await connection.getAccountInfo(address))) {
    tokenCli([
      "create-account",
      "--fee-payer",
      SENDER_WALLET,
      "--owner",
      owner.toBase58(),
      mint.toBase58(),
    ]);
  }
  return address;
}

function chainResult(value: unknown): void {
  console.log(`CHAIN_RESULT ${JSON.stringify(value)}`);
}

async function bootstrap(): Promise<void> {
  mkdirSync(DEMO_DIR, { recursive: true });
  // Validate and freeze the exact quote before creating wallets, requesting
  // airdrops, or submitting any transaction.
  const chainQuote = buildChainQuote();
  if (!existsSync(SENDER_WALLET)) {
    throw new Error(
      `demo sender wallet is missing: ${SENDER_WALLET}; run ./scripts/start-surfpool.sh first`,
    );
  }
  const research = ensureKeypair(RESEARCH_WALLET);
  const fulfillment = ensureKeypair(FULFILLMENT_WALLET);
  const treasury = ensureKeypair(TREASURY_WALLET);
  const provider = providerFor(SENDER_WALLET);
  const program = programFor(provider);
  for (const wallet of [research, fulfillment, treasury]) {
    await fundWallet(provider.connection, wallet.publicKey);
  }

  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const existingConfigInfo = await provider.connection.getAccountInfo(config);
  let mint: anchor.web3.PublicKey;
  let initializeSignature: string | null = null;
  if (existingConfigInfo) {
    const existing = await program.account.config.fetch(config);
    if (
      !existing.authority.equals(provider.wallet.publicKey) ||
      !existing.treasury.equals(treasury.publicKey) ||
      !existing.researchOracle.equals(research.publicKey) ||
      !existing.deliveryOracle.equals(fulfillment.publicKey) ||
      existing.feeBps !== FEE_BPS
    ) {
      throw new Error(
        "existing Config is not compatible with the local fulfillment demo wallets or fee policy",
      );
    }
    mint = existing.allowedMint;
    const mintAccount = await provider.connection.getParsedAccountInfo(mint);
    const parsed = mintAccount.value?.data;
    if (
      typeof parsed !== "object" ||
      !("parsed" in parsed) ||
      parsed.parsed?.info?.decimals !== chainQuote.currency_exponent
    ) {
      throw new Error(
        "existing Config mint decimals do not match the exact quote currency",
      );
    }
    console.log(`Reusing compatible Config PDA ${config.toBase58()}.`);
  } else {
    mint = new anchor.web3.PublicKey(
      findAddress(
        tokenCli([
          "create-token",
          "--fee-payer",
          SENDER_WALLET,
          "--mint-authority",
          provider.wallet.publicKey.toBase58(),
          "--decimals",
          String(chainQuote.currency_exponent),
        ]),
      ),
    );
  }
  const senderToken = await ensureAssociatedTokenAccount(
    provider.connection,
    provider.wallet.publicKey,
    mint,
  );
  const treasuryToken = await ensureAssociatedTokenAccount(
    provider.connection,
    treasury.publicKey,
    mint,
  );
  const operatorToken = await ensureAssociatedTokenAccount(
    provider.connection,
    fulfillment.publicKey,
    mint,
  );

  const hash = quoteHash(chainQuote);
  const maximumFee = Math.floor(
    (chainQuote.max_total_minor * FEE_BPS) / 10_000,
  );
  const budget = chainQuote.max_total_minor + maximumFee;
  tokenCli([
    "mint",
    "--fee-payer",
    SENDER_WALLET,
    "--mint-authority",
    SENDER_WALLET,
    mint.toBase58(),
    (budget / 10 ** chainQuote.currency_exponent).toFixed(
      chainQuote.currency_exponent,
    ),
    senderToken.toBase58(),
  ]);

  if (!existingConfigInfo) {
    initializeSignature = await program.methods
      .initialize(FEE_BPS)
      .accountsPartial({
        config,
        authority: provider.wallet.publicKey,
        treasury: treasury.publicKey,
        researchOracle: research.publicKey,
        deliveryOracle: fulfillment.publicKey,
        allowedMint: mint,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
  }
  const nonce = new anchor.BN(Date.now());
  const [campaign] = anchor.web3.PublicKey.findProgramAddressSync(
    [
      Buffer.from("campaign"),
      provider.wallet.publicKey.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    program.programId,
  );
  const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), campaign.toBuffer()],
    program.programId,
  );
  const campaignExpiry = new anchor.BN(
    Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
  );
  const createSignature = await program.methods
    .createCampaign(nonce, new anchor.BN(budget), campaignExpiry)
    .accountsPartial({
      config,
      campaign,
      vault,
      sender: provider.wallet.publicKey,
      senderToken,
      mint,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .rpc();
  const quoteSignature = await program.methods
    .submitQuote(
      1,
      chainQuote.job_kind,
      chainQuote.adapter,
      hashBytes(chainQuote.spec_hash),
      hashBytes(hash),
      hashBytes(sha256(chainQuote.merchant)),
      currencyBytes(chainQuote.currency),
      chainQuote.currency_exponent,
      currencyBytes(chainQuote.charge_currency),
      chainQuote.charge_currency_exponent,
      new anchor.BN(chainQuote.item_subtotal_minor),
      new anchor.BN(chainQuote.small_order_fee_minor),
      new anchor.BN(chainQuote.service_fee_minor),
      new anchor.BN(chainQuote.delivery_fee_minor),
      new anchor.BN(chainQuote.tip_minor),
      new anchor.BN(chainQuote.other_fees_minor),
      new anchor.BN(chainQuote.landed_total_minor),
      new anchor.BN(chainQuote.max_total_minor),
      new anchor.BN(chainQuote.settlement_amount),
      new anchor.BN(chainQuote.quoted_charge_amount_minor),
      new anchor.BN(chainQuote.settlement_units_per_charge_unit_micros),
      new anchor.BN(chainQuote.captured_at),
      new anchor.BN(chainQuote.expires_at),
    )
    .accountsPartial({ config, campaign, researchOracle: research.publicKey })
    .signers([research])
    .rpc();

  const addresses = {
    campaign,
    vault,
    mint,
    senderToken,
    treasuryToken,
    operatorToken,
  };
  const transactions: Record<string, string> = {
    create: createSignature,
    quote: quoteSignature,
  };
  if (initializeSignature) transactions.initialize = initializeSignature;
  const job = makeChainJob(chainQuote, hash, addresses, "quoted", transactions);
  // Persist the recoverable state before the human phrase. A typo must never
  // force a new escrow campaign or silently approve the quote.
  writePrivateJson(CHAIN_JOB_PATH, job);

  console.log("\nEXACT ON-CHAIN QUOTE APPROVAL");
  console.log(`Merchant: ${chainQuote.merchant}`);
  console.log(
    `Amount: ${formatMinor(
      chainQuote.landed_total_minor,
      chainQuote.currency_exponent,
      chainQuote.currency,
    )}`,
  );
  console.log(
    `Card charge: ${formatMinor(
      chainQuote.quoted_charge_amount_minor,
      chainQuote.charge_currency_exponent,
      chainQuote.charge_currency,
    )}`,
  );
  console.log(
    `Maximum: ${formatMinor(
      chainQuote.max_total_minor,
      chainQuote.currency_exponent,
      chainQuote.currency,
    )}`,
  );
  console.log(`Quote hash: ${hash}`);
  const readline = createInterface({ input: stdin, output: stdout });
  const phrase = `APPROVE QUOTE ${formatMinor(
    chainQuote.landed_total_minor,
    chainQuote.currency_exponent,
    chainQuote.currency,
  )}`;
  const answer = await readline.question(`Type ${phrase}: `);
  readline.close();
  if (answer !== phrase)
    throw new Error("exact quote approval was not provided");
  const approveSignature = await program.methods
    .approveQuote(1, hashBytes(hash))
    .accountsPartial({ campaign, sender: provider.wallet.publicKey })
    .rpc();
  job.status = "approved";
  job.transactions.approve = approveSignature;
  writePrivateJson(CHAIN_JOB_PATH, job);
  chainResult(job);
}

function preview(): void {
  const chainQuote = buildChainQuote();
  chainResult({
    status: "preview",
    job_kind_code: chainQuote.job_kind,
    adapter_code: chainQuote.adapter,
    merchant: chainQuote.merchant,
    currency: chainQuote.currency,
    landed_total_minor: chainQuote.landed_total_minor,
    max_total_minor: chainQuote.max_total_minor,
    quote_hash: quoteHash(chainQuote),
    expires_at: new Date(chainQuote.expires_at * 1_000).toISOString(),
  });
}

async function approvePending(): Promise<void> {
  const chainQuote = buildChainQuote();
  const hash = quoteHash(chainQuote);
  const provider = providerFor(SENDER_WALLET);
  const program = programFor(provider);
  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const configState = await program.account.config.fetch(config);
  const allCampaigns = await program.account.campaign.all();
  const candidates = allCampaigns.filter(({ account }) => {
    return (
      account.sender.equals(provider.wallet.publicKey) &&
      statusName(account.status as unknown as Record<string, unknown>) ===
        "quoted" &&
      account.quoteVersion === 1 &&
      Buffer.from(account.quoteHash).toString("hex") === hash &&
      Buffer.from(account.specHash).toString("hex") === chainQuote.spec_hash &&
      Buffer.from(account.merchantHash).toString("hex") ===
        sha256(chainQuote.merchant) &&
      account.landedTotalMinor.toNumber() === chainQuote.landed_total_minor &&
      account.maxTotalMinor.toNumber() === chainQuote.max_total_minor
    );
  });
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one matching pending quote, found ${candidates.length}`,
    );
  }
  const pending = candidates[0];
  if (
    pending.account.quoteExpiresAt.toNumber() < Math.floor(Date.now() / 1_000)
  ) {
    throw new Error(
      "the pending quote has expired; restart Surfpool and capture a fresh final checkout quote",
    );
  }
  const campaign = pending.publicKey;
  const [vault] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), campaign.toBuffer()],
    program.programId,
  );
  const fulfillment = loadKeypair(FULFILLMENT_WALLET);
  if (!configState.deliveryOracle.equals(fulfillment.publicKey)) {
    throw new Error("the pending Config uses a different fulfillment oracle");
  }
  const mint = configState.allowedMint;
  const senderToken = associatedTokenAddress(provider.wallet.publicKey, mint);
  const treasuryToken = associatedTokenAddress(configState.treasury, mint);
  const operatorToken = associatedTokenAddress(fulfillment.publicKey, mint);
  const history = await provider.connection.getSignaturesForAddress(campaign, {
    limit: 5,
  });

  console.log("\nRESUME EXACT ON-CHAIN QUOTE APPROVAL");
  console.log(`Campaign: ${campaign.toBase58()}`);
  console.log(`Merchant: ${chainQuote.merchant}`);
  console.log(
    `Amount: ${formatMinor(
      chainQuote.landed_total_minor,
      chainQuote.currency_exponent,
      chainQuote.currency,
    )}`,
  );
  console.log(`Quote hash: ${hash}`);
  const phrase = `APPROVE QUOTE ${formatMinor(
    chainQuote.landed_total_minor,
    chainQuote.currency_exponent,
    chainQuote.currency,
  )}`;
  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question(`Type ${phrase}: `);
  readline.close();
  if (answer !== phrase) {
    throw new Error("exact quote approval was not provided");
  }
  const approveSignature = await program.methods
    .approveQuote(1, hashBytes(hash))
    .accountsPartial({ campaign, sender: provider.wallet.publicKey })
    .rpc();
  const recoveredTransactions = Object.fromEntries(
    history.map(({ signature }, index) => [
      `recovered_${index + 1}`,
      signature,
    ]),
  );
  const job = makeChainJob(
    chainQuote,
    hash,
    {
      campaign,
      vault,
      mint,
      senderToken,
      treasuryToken,
      operatorToken,
    },
    "approved",
    { ...recoveredTransactions, approve: approveSignature },
  );
  writePrivateJson(CHAIN_JOB_PATH, job);
  chainResult(job);
}

function requireArtifactPath(raw: string | undefined): string {
  if (!raw) throw new Error("artifact path is required");
  const path = resolve(raw);
  if (!path.startsWith(`${AGENT_OUT}/`) || !existsSync(path)) {
    throw new Error("artifact must be an existing file inside agent/out");
  }
  return path;
}

async function withOracle(): Promise<{
  program: anchor.Program<GiftCampaign>;
  oracle: anchor.web3.Keypair;
  job: ChainJob;
  campaign: anchor.web3.PublicKey;
  config: anchor.web3.PublicKey;
}> {
  const walletPath = process.env.FULFILLMENT_ORACLE_WALLET
    ? resolve(process.env.FULFILLMENT_ORACLE_WALLET)
    : FULFILLMENT_WALLET;
  const oracle = loadKeypair(walletPath);
  const provider = providerFor(walletPath);
  const program = programFor(provider);
  const job = readJson<ChainJob>(CHAIN_JOB_PATH);
  const campaign = new anchor.web3.PublicKey(job.campaign);
  const [config] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  return { program, oracle, job, campaign, config };
}

function statusName(status: Record<string, unknown>): string {
  return Object.keys(status)[0] ?? "unknown";
}

async function verify(): Promise<void> {
  const { program, job, campaign } = await withOracle();
  const chainQuote = buildChainQuote();
  const hash = quoteHash(chainQuote);
  const state = await program.account.campaign.fetch(campaign);
  const status = statusName(state.status as unknown as Record<string, unknown>);
  if (status !== "approved")
    throw new Error(`campaign is ${status}, not approved`);
  if (
    hash !== job.quote_hash ||
    Buffer.from(state.quoteHash).toString("hex") !== hash ||
    Buffer.from(state.specHash).toString("hex") !== chainQuote.spec_hash ||
    state.landedTotalMinor.toNumber() !== chainQuote.landed_total_minor ||
    state.maxTotalMinor.toNumber() !== chainQuote.max_total_minor ||
    state.settlementAmount.toNumber() !== chainQuote.settlement_amount ||
    state.quotedChargeAmountMinor.toNumber() !==
      chainQuote.quoted_charge_amount_minor ||
    state.settlementUnitsPerChargeUnitMicros.toNumber() !==
      chainQuote.settlement_units_per_charge_unit_micros ||
    Buffer.from(state.currency).toString("ascii") !== chainQuote.currency ||
    state.currencyExponent !== chainQuote.currency_exponent ||
    Buffer.from(state.chargeCurrency).toString("ascii") !==
      chainQuote.charge_currency ||
    state.chargeCurrencyExponent !== chainQuote.charge_currency_exponent
  ) {
    throw new Error(
      "on-chain approval does not match the current exact quote.json",
    );
  }
  if (state.quoteExpiresAt.toNumber() < Math.floor(Date.now() / 1_000)) {
    throw new Error("the approved on-chain quote has expired");
  }
  chainResult({
    approved: true,
    campaign: campaign.toBase58(),
    quote_hash: hash,
    status,
  });
}

async function attempt(path: string): Promise<void> {
  const { program, oracle, job, campaign, config } = await withOracle();
  const artifactHash = sha256(canonicalize(readJson<unknown>(path)));
  const signature = await program.methods
    .recordPaymentAttempt(1, hashBytes(job.quote_hash), hashBytes(artifactHash))
    .accountsPartial({ config, campaign, fulfillmentOracle: oracle.publicKey })
    .signers([oracle])
    .rpc();
  chainResult({
    status: "paymentAttempted",
    artifact_hash: artifactHash,
    signature,
  });
}

async function auth(path: string): Promise<void> {
  const artifact = readJson<{ currency: string; amount_minor: number }>(path);
  const { program, oracle, campaign, config } = await withOracle();
  const artifactHash = sha256(canonicalize(artifact));
  const signature = await program.methods
    .recordPaymentAuth(
      hashBytes(artifactHash),
      currencyBytes(artifact.currency),
      new anchor.BN(artifact.amount_minor),
    )
    .accountsPartial({ config, campaign, fulfillmentOracle: oracle.publicKey })
    .signers([oracle])
    .rpc();
  chainResult({
    status: "paymentAuthenticated",
    artifact_hash: artifactHash,
    signature,
  });
}

async function purchase(path: string): Promise<void> {
  const artifact = readJson<{
    currency: string;
    amount_minor: number;
    order_id: string;
  }>(path);
  const { program, oracle, campaign, config } = await withOracle();
  const artifactHash = sha256(canonicalize(artifact));
  const orderHash = sha256(artifact.order_id);
  const signature = await program.methods
    .recordPurchase(
      hashBytes(artifactHash),
      hashBytes(orderHash),
      currencyBytes(artifact.currency),
      new anchor.BN(artifact.amount_minor),
    )
    .accountsPartial({ config, campaign, fulfillmentOracle: oracle.publicKey })
    .signers([oracle])
    .rpc();
  chainResult({
    status: "purchased",
    artifact_hash: artifactHash,
    order_id_hash: orderHash,
    signature,
  });
}

async function settle(proofPath: string): Promise<void> {
  const proof = resolve(proofPath);
  if (!existsSync(proof))
    throw new Error(`proof file does not exist: ${proof}`);
  const fulfillmentPath = resolve(AGENT_OUT, "fulfillment.json");
  if (!existsSync(fulfillmentPath))
    throw new Error("agent/out/fulfillment.json is missing");
  const { program, oracle, job, campaign, config } = await withOracle();
  const signature = await program.methods
    .settleFulfillment(
      hashBytes(sha256(readFileSync(proof))),
      hashBytes(sha256(canonicalize(readJson<unknown>(fulfillmentPath)))),
    )
    .accountsPartial({
      config,
      campaign,
      vault: new anchor.web3.PublicKey(job.vault),
      senderToken: new anchor.web3.PublicKey(job.sender_token),
      treasuryToken: new anchor.web3.PublicKey(job.treasury_token),
      operatorToken: new anchor.web3.PublicKey(job.operator_token),
      fulfillmentOracle: oracle.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([oracle])
    .rpc();
  chainResult({ status: "settled", signature });
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === "preview") return preview();
  if (command === "replay-devnet") return replayDevnet();
  if (command === "approve-pending") return approvePending();
  if (command === "bootstrap") return bootstrap();
  if (command === "verify") return verify();
  if (command === "attempt") return attempt(requireArtifactPath(argument));
  if (command === "auth") return auth(requireArtifactPath(argument));
  if (command === "purchase") return purchase(requireArtifactPath(argument));
  if (command === "settle") {
    if (!argument) throw new Error("proof path is required");
    return settle(argument);
  }
  throw new Error(
    "usage: fulfillment:chain preview|replay-devnet|bootstrap|approve-pending|verify|attempt <artifact>|auth <artifact>|purchase <artifact>|settle <proof>",
  );
}

main().catch((error: unknown) => {
  console.error(
    `CHAIN HARD FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
