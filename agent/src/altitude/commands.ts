import { writeJson } from "../files.js";
import type { AltitudeSession } from "./session.js";

/**
 * Card command surface exposed by the Altitude daemon.
 *
 * Every command validates its payload against the funding policy and then
 * stops at a stub: the dashboard selectors are not known yet, so nothing here
 * mutates the account. Each stub reports what recon is still missing.
 */

export const CARD_COMMANDS = ["create", "fund", "freeze", "close"] as const;
export type CardCommand = (typeof CARD_COMMANDS)[number];

export const SETTLEMENT_CURRENCIES = ["USDC", "SOL"] as const;
export type SettlementCurrency = (typeof SETTLEMENT_CURRENCIES)[number];

export interface CardCommandRequest {
  command: CardCommand;
  reference: string;
  amountUsd?: number;
  currency?: SettlementCurrency;
  cardId?: string;
}

export interface CardCommandResult {
  ok: boolean;
  status: "stub";
  command: CardCommand;
  request: CardCommandRequest;
  recon_needed: string[];
  observed: { url: string; screenshot: string };
  at: string;
}

export interface BalanceResult {
  ok: boolean;
  status: "stub";
  recon_needed: string[];
  observed: { url: string; screenshot: string };
  at: string;
}

const RECON_BY_COMMAND: Record<CardCommand, string[]> = {
  create: [
    "selector for the create-card control and the resulting card id",
    "whether card creation re-prompts the passkey",
    "where the PAN/CVV/expiry are rendered so they can be captured without logging",
  ],
  fund: [
    "selector for the transfer/top-up form from the Squads account to the card",
    "whether funding re-prompts the passkey",
    "the settlement confirmation element that proves the balance moved",
  ],
  freeze: ["selector for the freeze toggle and its confirmed state"],
  close: ["selector for the close-card control and its confirmation dialog"],
};

function maxCardUsd(): number {
  const raw = (process.env.ALTITUDE_MAX_CARD_USD ?? "").trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "ALTITUDE_MAX_CARD_USD must be set to a positive per-card spend cap",
    );
  }
  return parsed;
}

export function assertCardAmountWithinCap(
  amountUsd: number,
  maxUsd: number,
): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("card amount is missing or invalid; command is blocked");
  }
  if (amountUsd > maxUsd) {
    throw new Error(
      `HARD FAIL: card amount ${amountUsd.toFixed(2)} USD exceeds ALTITUDE_MAX_CARD_USD ${maxUsd.toFixed(2)} USD`,
    );
  }
}

export function validateCardCommand(
  body: unknown,
  maxUsd = maxCardUsd(),
): CardCommandRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const command = raw.command;
  if (
    typeof command !== "string" ||
    !CARD_COMMANDS.includes(command as CardCommand)
  ) {
    throw new Error(`command must be one of ${CARD_COMMANDS.join(", ")}`);
  }
  const reference = raw.reference;
  if (typeof reference !== "string" || !/^[\w.:-]{4,64}$/.test(reference)) {
    throw new Error(
      "reference must be a 4-64 character order reference so the command is auditable",
    );
  }
  const request: CardCommandRequest = {
    command: command as CardCommand,
    reference,
  };

  if (command === "create" || command === "fund") {
    const amountUsd = Number(raw.amount_usd);
    assertCardAmountWithinCap(amountUsd, maxUsd);
    request.amountUsd = amountUsd;
    const currency = (raw.currency ?? "USDC") as SettlementCurrency;
    if (!SETTLEMENT_CURRENCIES.includes(currency)) {
      throw new Error(
        `currency must be one of ${SETTLEMENT_CURRENCIES.join(", ")}`,
      );
    }
    request.currency = currency;
  }

  if (command !== "create") {
    const cardId = raw.card_id;
    if (typeof cardId !== "string" || cardId.length === 0) {
      throw new Error(`card_id is required for the ${command} command`);
    }
    request.cardId = cardId;
  }

  return request;
}

export async function runCardCommand(
  session: AltitudeSession,
  request: CardCommandRequest,
): Promise<CardCommandResult> {
  const screenshot = await session.screenshot(
    `altitude-card-${request.command}.png`,
  );
  const result: CardCommandResult = {
    ok: false,
    status: "stub",
    command: request.command,
    request,
    recon_needed: RECON_BY_COMMAND[request.command],
    observed: { url: session.page.url(), screenshot },
    at: new Date().toISOString(),
  };
  writeJson(`altitude-card-${request.command}.json`, result);
  return result;
}

export async function readBalance(
  session: AltitudeSession,
): Promise<BalanceResult> {
  const screenshot = await session.screenshot("altitude-balance.png");
  const result: BalanceResult = {
    ok: false,
    status: "stub",
    recon_needed: [
      "selector for the Squads account balance and each card's balance",
      "whether balances are rendered server-side or behind an authenticated XHR worth reading directly",
    ],
    observed: { url: session.page.url(), screenshot },
    at: new Date().toISOString(),
  };
  writeJson("altitude-balance.json", result);
  return result;
}
