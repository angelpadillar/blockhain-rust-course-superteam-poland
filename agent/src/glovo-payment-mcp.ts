import { verifyConfirmation } from "./browser.js";
import {
  buildPaymentAttemptArtifact,
  ensureApprovedQuoteOnChain,
  recordPaymentAttemptOnChain,
} from "./chain.js";
import {
  loadCardSecrets,
  loadConfig,
  loadRuntimeOptions,
  renderNote,
} from "./config.js";
import { ensureOutputDirectories, readJson, writeJson } from "./files.js";
import {
  assertAmountWithinCap,
  assertSecretPathsIgnored,
  beginSingleCardAttempt,
  finishSingleCardAttempt,
  redactSensitive,
} from "./policy.js";
import { requireExactConfirmation } from "./prompts.js";
import type { QuoteOutput } from "./types.js";

const QUOTE_MAX_AGE_MS = 10 * 60_000;
const PREFLIGHT_MAX_AGE_MS = 5 * 60_000;

function isGlovoCheckout(raw: string): boolean {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLocaleLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "glovoapp.com" || host.endsWith(".glovoapp.com")) &&
      /(?:checkout|order-summary)/i.test(`${url.pathname}${url.hash}`)
    );
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  ensureOutputDirectories();
  assertSecretPathsIgnored();
  const config = loadConfig();
  const options = loadRuntimeOptions();
  const note = renderNote(config.note, options.nonce);
  if (config.adapter !== "glovo" || config.job_kind !== "food") {
    throw new Error("payment:glovo requires the Glovo food adapter");
  }
  if (!options.allowPay || !options.allowThreeDsSubmit) {
    throw new Error(
      "payment:glovo requires ALLOW_PAY=true and ALLOW_3DS_SUBMIT=true for this one run",
    );
  }
  if (!options.allowSaveCard) {
    throw new Error(
      "payment:glovo requires ALLOW_SAVE_CARD=true because Glovo stores newly entered cards as the account default",
    );
  }
  verifyConfirmation(config, options, note);

  const quote = readJson<QuoteOutput>("quote.json");
  if (
    quote.adapter !== "glovo" ||
    quote.landed_pln === null ||
    quote.source_url === null ||
    !isGlovoCheckout(quote.source_url)
  ) {
    throw new Error("quote.json is not a payable Glovo checkout quote");
  }
  assertAmountWithinCap(quote.landed_pln, config.max_pln);
  const capturedAt = new Date(quote.captured_at);
  const quoteAge = Date.now() - capturedAt.valueOf();
  if (
    Number.isNaN(capturedAt.valueOf()) ||
    quoteAge < 0 ||
    quoteAge > QUOTE_MAX_AGE_MS
  ) {
    throw new Error(
      "Glovo MCP quote is older than 10 minutes; visually recapture and approve a fresh quote",
    );
  }

  const observed = readJson<{ merchant?: unknown }>(
    "mcp-browser-observation.json",
  );
  const merchant =
    typeof observed.merchant === "string" ? observed.merchant.trim() : "";
  if (!merchant) {
    throw new Error("Glovo MCP observation has no verified merchant name");
  }

  const card = loadCardSecrets(options);
  await requireExactConfirmation(
    [
      "MCP CHECKOUT PAYMENT PREFLIGHT",
      "The existing supervised Glovo checkout must still visibly show the approved non-alcoholic basket.",
      `Merchant: ${merchant}`,
      `Amount: ${quote.landed_pln.toFixed(2)} PLN`,
      `Altitude virtual Visa: **** ${card.last4}`,
      "Glovo will store this card as the account default for future orders; this one run explicitly allows that.",
      "After this preflight, Codex may open the payment method once and transmit the card only to a verified Glovo payment surface.",
      "No retry is authorized.",
    ].join("\n"),
    `PAY ${quote.landed_pln.toFixed(2)} ${card.last4}`,
  );

  let attemptStarted = false;
  try {
    ensureApprovedQuoteOnChain(options);
    beginSingleCardAttempt(card.last4, quote.landed_pln);
    attemptStarted = true;
    const attempt = buildPaymentAttemptArtifact(quote, card.last4);
    const attemptResult = recordPaymentAttemptOnChain(options, attempt);
    const preparedAt = new Date();
    writeJson("mcp-payment-preflight.json", {
      status: "ready_for_supervised_browser_payment",
      adapter: "glovo",
      source_url: quote.source_url,
      amount_pln: quote.landed_pln,
      currency: quote.charge_currency,
      card_last4: card.last4,
      quote_captured_at: quote.captured_at,
      prepared_at: preparedAt.toISOString(),
      expires_at: new Date(
        preparedAt.valueOf() + PREFLIGHT_MAX_AGE_MS,
      ).toISOString(),
      payment_attempt_signature: String(attemptResult.signature),
      browser_driver: "mcp_existing_session",
    });
    console.log(
      `MCP payment preflight ready for ${quote.landed_pln.toFixed(2)} PLN on card ending ${card.last4}.`,
    );
    console.log(
      "Return to the active Codex task and type EXECUTE APPROVED GLOVO PAYMENT.",
    );
    console.log(
      "Do not run this command again. The one-attempt marker is now active.",
    );
    attemptStarted = false;
  } catch (error) {
    if (attemptStarted) {
      finishSingleCardAttempt("hard_fail", (error as Error).message);
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const safe = redactSensitive(String((error as Error).message), [
    process.env.CARD_PAN ?? "",
    process.env.CARD_CVC ?? "",
  ]);
  console.error(`GLOVO MCP PREFLIGHT HARD FAIL: ${safe}`);
  process.exitCode = 1;
});
