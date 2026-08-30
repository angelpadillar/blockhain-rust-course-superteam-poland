import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { outputPath, readJson, writeJson } from "./files.js";
import { repoRoot } from "./paths.js";
import type {
  PaidOutput,
  PaymentAttemptArtifact,
  PaymentAuthArtifact,
  PurchaseArtifact,
  QuoteOutput,
  RuntimeOptions,
  ThreeDsAudit,
} from "./types.js";

const CHAIN_SCRIPT = resolve(repoRoot, "scripts/fulfillment-chain.ts");
const TS_NODE = resolve(repoRoot, "node_modules/.bin/ts-node");

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

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function toMinor(value: number, label: string, exponent: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} is missing or invalid`);
  }
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw new Error(`${label} currency exponent is invalid`);
  }
  const scale = 10 ** exponent;
  const minor = Math.round(value * scale);
  if (Math.abs(minor / scale - value) > 0.000_001) {
    throw new Error(`${label} has too many decimal places`);
  }
  return minor;
}

function exactCharge(quote: QuoteOutput): {
  currency: string;
  amount: number;
  amountMinor: number;
} {
  if (
    quote.charge_currency === null ||
    !/^[A-Z]{3}$/.test(quote.charge_currency) ||
    quote.charge_amount === null ||
    quote.charge_currency_exponent === null
  ) {
    throw new Error("quote.json has no exact card currency and amount");
  }
  return {
    currency: quote.charge_currency,
    amount: quote.charge_amount,
    amountMinor: toMinor(
      quote.charge_amount,
      "quoted card amount",
      quote.charge_currency_exponent,
    ),
  };
}

function merchantFromLocalEvidence(quote: QuoteOutput): string {
  const observationPath = outputPath("mcp-browser-observation.json");
  if (existsSync(observationPath)) {
    const observed = JSON.parse(readFileSync(observationPath, "utf8")) as {
      merchant?: unknown;
    };
    if (typeof observed.merchant === "string" && observed.merchant.trim()) {
      return observed.merchant.trim();
    }
  }
  if (quote.source_url) return new URL(quote.source_url).hostname;
  return "manual merchant";
}

function runChain(
  options: RuntimeOptions,
  action: "verify" | "attempt" | "auth" | "purchase",
  artifactName?: string,
): Record<string, unknown> {
  if (!existsSync(TS_NODE) || !existsSync(CHAIN_SCRIPT)) {
    throw new Error(
      "Solana lifecycle client is not built; run yarn install and anchor build at the repository root",
    );
  }
  const args = [CHAIN_SCRIPT, action];
  if (artifactName) args.push(outputPath(artifactName));
  let output: string;
  try {
    output = execFileSync(TS_NODE, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ANCHOR_PROVIDER_URL: options.solanaRpcUrl,
        FULFILLMENT_ORACLE_WALLET: options.fulfillmentOracleWallet,
      },
    });
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    throw new Error(
      `Solana lifecycle ${action} failed${detail.trim() ? `: ${detail.trim()}` : ""}`,
    );
  }
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.startsWith("CHAIN_RESULT "));
  if (!line) throw new Error(`Solana lifecycle ${action} returned no result`);
  return JSON.parse(line.slice("CHAIN_RESULT ".length)) as Record<
    string,
    unknown
  >;
}

function bootstrapExactQuoteOnChain(options: RuntimeOptions): void {
  if (!existsSync(TS_NODE) || !existsSync(CHAIN_SCRIPT)) {
    throw new Error(
      "Solana lifecycle client is not built; run yarn install and anchor build at the repository root",
    );
  }
  console.log(
    "No on-chain job exists for this final quote. Starting the sender-signed escrow and exact-quote approval gate.",
  );
  try {
    execFileSync(TS_NODE, [CHAIN_SCRIPT, "bootstrap"], {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        ANCHOR_PROVIDER_URL: options.solanaRpcUrl,
        FULFILLMENT_ORACLE_WALLET: options.fulfillmentOracleWallet,
      },
    });
  } catch {
    throw new Error(
      "exact on-chain quote approval failed; no card data was loaded and Pay was not clicked",
    );
  }
}

export function verifyApprovedQuoteOnChain(
  options: RuntimeOptions,
): Record<string, unknown> {
  return runChain(options, "verify");
}

export function ensureApprovedQuoteOnChain(
  options: RuntimeOptions,
): Record<string, unknown> {
  if (!existsSync(outputPath("chain-job.json"))) {
    bootstrapExactQuoteOnChain(options);
  }
  return verifyApprovedQuoteOnChain(options);
}

export function buildPaymentAttemptArtifact(
  quote: QuoteOutput,
  cardLast4: string,
): PaymentAttemptArtifact {
  if (!/^\d{4}$/.test(cardLast4)) throw new Error("card last four is invalid");
  const charge = exactCharge(quote);
  return {
    kind: "payment_attempt",
    quote_sha256: sha256(quote),
    currency: charge.currency,
    amount_minor: charge.amountMinor,
    merchant: merchantFromLocalEvidence(quote),
    card_last4: cardLast4,
    attempted_at: new Date().toISOString(),
  };
}

export function recordPaymentAttemptOnChain(
  options: RuntimeOptions,
  artifact: PaymentAttemptArtifact,
): Record<string, unknown> {
  writeJson("payment-attempt.json", artifact);
  return runChain(options, "attempt", "payment-attempt.json");
}

export function buildPaymentAuthArtifact(
  quote: QuoteOutput,
  audit: ThreeDsAudit,
): PaymentAuthArtifact {
  const charge = exactCharge(quote);
  const exponent = quote.charge_currency_exponent;
  if (exponent === null) {
    throw new Error("quote.json has no card currency exponent");
  }
  if (
    audit.currency !== charge.currency ||
    Math.abs(audit.amount - charge.amount) > 0.5 / 10 ** exponent
  ) {
    throw new Error(
      "3DS authentication does not match the exact approved card charge",
    );
  }
  return {
    kind: "payment_auth",
    provider: audit.provider,
    mode: audit.mode,
    currency: audit.currency,
    amount_minor: toMinor(audit.amount, "authenticated amount", exponent),
    merchant: audit.merchant,
    from: audit.from,
    completed_at: audit.completed_at,
  };
}

export function recordPaymentAuthOnChain(
  options: RuntimeOptions,
  artifact: PaymentAuthArtifact,
): Record<string, unknown> {
  writeJson("payment-auth.json", artifact);
  return runChain(options, "auth", "payment-auth.json");
}

export function buildPurchaseArtifact(
  quote: QuoteOutput,
  paid: PaidOutput,
  merchant: string,
): PurchaseArtifact {
  const charge = exactCharge(quote);
  if (
    quote.landed_pln === null ||
    Math.abs(paid.amount_pln - quote.landed_pln) > 0.01
  ) {
    throw new Error("merchant confirmation amount does not match quote.json");
  }
  return {
    kind: "purchase",
    currency: charge.currency,
    amount_minor: charge.amountMinor,
    order_id: paid.order_id,
    merchant,
    confirmed_at: new Date().toISOString(),
  };
}

export function recordPurchaseOnChain(
  options: RuntimeOptions,
  artifact: PurchaseArtifact,
): Record<string, unknown> {
  writeJson("purchase.json", artifact);
  return runChain(options, "purchase", "purchase.json");
}
