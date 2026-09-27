import { existsSync } from "node:fs";
import {
  loadCardSecrets,
  loadConfig,
  loadRuntimeOptions,
  renderNote,
} from "../config.js";
import { outputPath, readJson } from "../files.js";
import { assertAmountWithinCap, assertSecretPathsIgnored } from "../policy.js";
import { verifyConfirmation } from "../browser.js";
import { runPyszneCheckoutFlow } from "../pyszne-payment.js";
import { hostMatches, PYSZNE_HOST } from "../pyszne-payment-policy.js";
import type { CardSecrets, QuoteOutput } from "../types.js";
import { assertOrderPayable } from "./gates.js";
import {
  loadOrder,
  recordPurchase,
  transitionOrder,
  updateOrder,
  type OrderRecord,
} from "./store.js";

export type PaymentOutcome =
  | "purchased"
  | "already_purchased"
  | "blocked"
  | "failed"
  | "requires_reauthorization";

export interface ExecutePaymentResult {
  order_id: string;
  outcome: PaymentOutcome;
  merchant_order_id?: string | undefined;
  amount_pln?: number | undefined;
  detail: string;
}

const ALTITUDE_SERVER_URL =
  process.env.ALTITUDE_SERVER_URL?.trim() || "http://127.0.0.1:8787";
const USD_PLN_RATE = Number(process.env.USD_PLN_RATE ?? "4.0") || 4.0;

interface BalanceView {
  spendableUsd: number;
  cardLast4: string | null;
  cardActive: boolean;
}

/**
 * Read the supervised Altitude daemon's live balance. The daemon holds the
 * logged-in session; payment execution itself never talks to Altitude's UI.
 * Fails closed when the daemon or session is unavailable.
 */
export async function readAltitudeBalance(
  cardLast4: string,
): Promise<BalanceView> {
  const token = (process.env.ALTITUDE_SERVER_TOKEN ?? "").trim();
  if (!token) {
    throw new Error(
      "ALTITUDE_SERVER_TOKEN is unset; the balance gate cannot reach the daemon",
    );
  }
  let body: string;
  try {
    const response = await fetch(`${ALTITUDE_SERVER_URL}/balance`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(45_000),
    });
    body = await response.text();
  } catch (error) {
    throw new Error(
      `Altitude daemon unreachable at ${ALTITUDE_SERVER_URL} — start npm run altitude:server and attach a session (${(error as Error).message})`,
    );
  }
  let parsed: {
    ok?: boolean;
    spendable_usd?: number;
    cards?: { last4?: string; status?: string }[];
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new Error("Altitude daemon /balance returned unreadable JSON");
  }
  if (parsed.ok !== true || typeof parsed.spendable_usd !== "number") {
    throw new Error(
      `Altitude daemon /balance not ready (${body.slice(0, 200)})`,
    );
  }
  const card = (parsed.cards ?? []).find(
    (entry) => entry.last4 === cardLast4,
  );
  return {
    spendableUsd: parsed.spendable_usd,
    cardLast4: card?.last4 ?? null,
    cardActive: card?.status === "Active",
  };
}

function requiredUsd(quote: QuoteOutput): number {
  if (quote.charge_amount === null || quote.charge_currency === null) {
    throw new Error("quote.json has no exact card charge for the balance gate");
  }
  if (quote.charge_currency.toLocaleUpperCase() === "USD") {
    return quote.charge_amount;
  }
  return quote.charge_amount / USD_PLN_RATE;
}

function loadPayableQuote(config: { adapter: string; max_pln: number }): QuoteOutput {
  const quote = readJson<QuoteOutput>("quote.json");
  if (
    quote.adapter !== config.adapter ||
    quote.landed_pln === null ||
    quote.source_url === null
  ) {
    throw new Error("quote.json is not a payable checkout quote for this order");
  }
  assertAmountWithinCap(quote.landed_pln, config.max_pln);
  const quoteAge = Date.now() - new Date(quote.captured_at).valueOf();
  if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > 10 * 60_000) {
    throw new Error("quote is older than 10 minutes; recapture before paying");
  }
  const source = new URL(quote.source_url);
  if (
    source.protocol !== "https:" ||
    !hostMatches(source.hostname.toLocaleLowerCase(), PYSZNE_HOST) ||
    !/checkout/i.test(source.pathname)
  ) {
    throw new Error("quote source is not an HTTPS Pyszne checkout URL");
  }
  return quote;
}

function isPriceChangeError(error: unknown): boolean {
  return /total changed/i.test((error as Error).message);
}

/**
 * executePayment(orderId) — the single entry point the rest of the system
 * uses. Never returns or logs card credentials.
 */
export async function executePayment(
  orderId: string,
): Promise<ExecutePaymentResult> {
  assertSecretPathsIgnored();
  const order = loadOrder(orderId);

  if (order.status === "PURCHASED") {
    const purchase = order.purchase;
    return {
      order_id: order.order_id,
      outcome: "already_purchased",
      merchant_order_id: purchase?.merchant_order_id,
      amount_pln: purchase?.amount_pln,
      detail: "order already purchased; returning the recorded result — no new charge",
    };
  }

  const config = loadConfig();
  const options = loadRuntimeOptions();
  const note = renderNote(config.note, options.nonce);
  if (!options.allowPay || !options.allowThreeDsSubmit) {
    return {
      order_id: order.order_id,
      outcome: "blocked",
      detail:
        "ALLOW_PAY=true and ALLOW_3DS_SUBMIT=true are required for payment execution",
    };
  }
  verifyConfirmation(config, options, note);
  const quote = loadPayableQuote(config);
  const card: CardSecrets = loadCardSecrets(options);

  let balance: BalanceView;
  try {
    balance = await readAltitudeBalance(card.last4);
  } catch (error) {
    return {
      order_id: order.order_id,
      outcome: "blocked",
      detail: (error as Error).message,
    };
  }

  try {
    assertOrderPayable({
      order,
      configAdapter: config.adapter,
      quoteLandedPln: quote.landed_pln ?? -1,
      spendableUsd: balance.spendableUsd,
      requiredUsd: requiredUsd(quote),
      cardLast4: card.last4,
      cardActive: balance.cardActive,
      cardAttemptInFlight: existsSync(outputPath("card-attempt.json")),
    });
  } catch (error) {
    return {
      order_id: order.order_id,
      outcome: "blocked",
      detail: (error as Error).message,
    };
  }

  let current: OrderRecord =
    order.status === "AUTHORIZED"
      ? order
      : transitionOrder(order, "AUTHORIZED", "all payment gates passed");
  const attemptId = `att-${order.order_id}`;

  try {
    const result = await runPyszneCheckoutFlow({
      config,
      options,
      quote,
      card,
      hooks: {
        onAttemptStarted: () => {
          current = updateOrder(current, { payment_attempt_id: attemptId });
        },
        onPaymentSubmitted: () => {
          current = transitionOrder(
            { ...current, payment_attempt_id: attemptId },
            "PAYMENT_SUBMITTED",
            `card submitted to Pyszne/PayU for ${quote.landed_pln?.toFixed(2)} PLN`,
          );
        },
        onWaitingFor3ds: () => {
          current = transitionOrder(
            current,
            "WAITING_FOR_3DS",
            "card-network challenge detected; polling AgentMail",
          );
        },
      },
    });

    current = transitionOrder(
      current,
      "PAYMENT_CONFIRMED",
      `3DS ${result.threeDs.mode} via ${result.threeDs.provider}`,
    );
    current = recordPurchase(current, {
      merchant_order_id: result.paid.order_id,
      amount_pln: result.paid.amount_pln,
      confirmed_at: new Date().toISOString(),
    });
    return {
      order_id: order.order_id,
      outcome: "purchased",
      merchant_order_id: result.paid.order_id,
      amount_pln: result.paid.amount_pln,
      detail: `merchant order ${result.paid.order_id} confirmed`,
    };
  } catch (error) {
    const message = (error as Error).message;
    const latest = loadOrder(order.order_id);
    if (isPriceChangeError(error)) {
      transitionOrder(
        latest,
        "REQUIRES_REAUTHORIZATION",
        `price moved during checkout: ${message}`,
      );
      return {
        order_id: order.order_id,
        outcome: "requires_reauthorization",
        detail: message,
      };
    }
    if (latest.status !== "PURCHASED") {
      try {
        transitionOrder(latest, "PAYMENT_FAILED", message.slice(0, 300));
      } catch {
        // Terminal or in-flight states cannot transition; leave as-is.
      }
    }
    return { order_id: order.order_id, outcome: "failed", detail: message };
  }
}
