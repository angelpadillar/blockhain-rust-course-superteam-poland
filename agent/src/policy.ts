import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { outputPath, readJson, writeJson } from "./files.js";
import { repoRoot } from "./paths.js";

const REQUIRED_IGNORES = [
  "agent/config.local.json",
  "agent/.env",
  "agent/out/",
  "agent/chrome-profile/",
  "agent/glovo-profile/",
  "agent/pyszne-profile/",
  "agent/altitude-profile/",
];

export function assertAmountWithinCap(amountPln: number, maxPln: number): void {
  if (!Number.isFinite(amountPln) || amountPln <= 0) {
    throw new Error("checkout total is missing or invalid; payment is blocked");
  }
  if (amountPln > maxPln) {
    throw new Error(
      `HARD FAIL: cart total ${amountPln.toFixed(2)} PLN exceeds max_pln ${maxPln.toFixed(2)} PLN`,
    );
  }
}

export function assertSecretPathsIgnored(): void {
  const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");
  for (const pattern of REQUIRED_IGNORES) {
    if (!gitignore.split(/\r?\n/).includes(pattern)) {
      throw new Error(
        `.gitignore is missing required secret pattern: ${pattern}`,
      );
    }
  }
}

export type CardAttemptStatus =
  | "started"
  | "auth_pending"
  | "success"
  | "hard_fail"
  | "reconciled_no_charge";

export interface CardAttemptRecord {
  status: CardAttemptStatus;
  last4?: string;
  amount_pln?: number;
  started_at?: string;
  auth_pending_at?: string;
  detail?: string;
  finished_at?: string;
  reconciled_at?: string;
}

export function cardAttemptAuthPending(
  current: CardAttemptRecord,
  detail: string,
  at = new Date(),
): CardAttemptRecord {
  if (current.status !== "started" && current.status !== "auth_pending") {
    throw new Error(
      `card attempt cannot enter auth_pending from ${current.status}`,
    );
  }
  return {
    ...current,
    status: "auth_pending",
    detail,
    auth_pending_at: at.toISOString(),
  };
}

export function cardAttemptFinished(
  current: CardAttemptRecord,
  status: "success" | "hard_fail",
  detail: string,
  at = new Date(),
): CardAttemptRecord {
  if (
    current.status !== "started" &&
    current.status !== "auth_pending"
  ) {
    throw new Error(
      `card attempt cannot finish as ${status} from ${current.status}`,
    );
  }
  return {
    ...current,
    status,
    detail,
    finished_at: at.toISOString(),
  };
}

export function cardAttemptReconciledNoCharge(
  current: CardAttemptRecord,
  detail: string,
  at = new Date(),
): CardAttemptRecord {
  if (current.status !== "auth_pending" && current.status !== "hard_fail") {
    throw new Error(
      `card attempt cannot be reconciled with no charge from ${current.status}`,
    );
  }
  return {
    ...current,
    status: "reconciled_no_charge",
    detail,
    reconciled_at: at.toISOString(),
  };
}

export function assertCardAttemptCanArchive(
  current: CardAttemptRecord,
): void {
  if (
    current.status === "started" ||
    current.status === "auth_pending" ||
    current.status === "hard_fail"
  ) {
    throw new Error(
      "card attempt is unresolved; confirm card and merchant status with npm run payment:reconcile before resetting",
    );
  }
}

export function beginSingleCardAttempt(last4: string, amountPln: number): void {
  const path = outputPath("card-attempt.json");
  if (existsSync(path)) {
    throw new Error(
      "A card attempt already exists. One-attempt policy blocks all automatic retries. Inspect agent/out/card-attempt.json and finish manually.",
    );
  }
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        status: "started",
        last4,
        amount_pln: amountPln,
        started_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
}

export function finishSingleCardAttempt(
  status: "success" | "hard_fail",
  detail: string,
): void {
  const current = readJson<CardAttemptRecord>("card-attempt.json");
  writeJson(
    "card-attempt.json",
    cardAttemptFinished(current, status, detail),
  );
}

export function markSingleCardAttemptAuthPending(detail: string): void {
  const current = readJson<CardAttemptRecord>("card-attempt.json");
  writeJson(
    "card-attempt.json",
    cardAttemptAuthPending(current, detail),
  );
}

export function reconcileSingleCardAttemptNoCharge(detail: string): void {
  const current = readJson<CardAttemptRecord>("card-attempt.json");
  writeJson(
    "card-attempt.json",
    cardAttemptReconciledNoCharge(current, detail),
  );
}

export function redactSensitive(value: string, secrets: string[] = []): string {
  let redacted = value.replace(/\b\d{12,19}\b/g, "[REDACTED_CARD]");
  for (const secret of secrets.filter(Boolean)) {
    redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}
