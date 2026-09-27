import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { secretsDir } from "../paths.js";

export const FULFILLMENT_CARD_FILE = "altitude-fulfillment-card.env";

export function fulfillmentCardPath(): string {
  return resolve(secretsDir, FULFILLMENT_CARD_FILE);
}

/**
 * Read the provisioned fulfillment-card env file. Returns null when absent.
 * The file must be owner-only (0600); a looser mode fails closed.
 */
export function readFulfillmentCardFile(): Record<
  string,
  string | undefined
> | null {
  const path = fulfillmentCardPath();
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      `${FULFILLMENT_CARD_FILE} has permissions ${mode.toString(8)}; expected 600. Fix with: chmod 600 ${path}`,
    );
  }
  return dotenv.parse(readFileSync(path, "utf8"));
}

/** Write provisioned card vars atomically with owner-only permissions. */
export function writeFulfillmentCardFile(
  vars: Record<string, string>,
): string {
  mkdirSync(secretsDir, { recursive: true });
  const path = fulfillmentCardPath();
  const body = Object.entries(vars)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(path, `${body}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
