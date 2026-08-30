import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, sha256File, writeJson } from "./files.js";
import { assertAmountWithinCap } from "./policy.js";
import type {
  AgentConfig,
  FulfillmentOutput,
  PaidOutput,
  RuntimeOptions,
} from "./types.js";

export function validatePaidOutput(value: unknown): PaidOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("paid.json must contain an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.order_id !== "string" ||
    !/^[A-Za-z0-9-]{4,80}$/.test(record.order_id)
  ) {
    throw new Error("paid.json.order_id is missing or invalid");
  }
  if (record.status !== "paid" && record.status !== "confirmed") {
    throw new Error("paid.json.status must be paid or confirmed");
  }
  if (
    typeof record.amount_pln !== "number" ||
    !Number.isFinite(record.amount_pln)
  ) {
    throw new Error("paid.json.amount_pln must be a number");
  }
  return {
    order_id: record.order_id,
    status: record.status,
    amount_pln: record.amount_pln,
  };
}

export function writeFulfillment(
  paid: PaidOutput,
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): FulfillmentOutput {
  assertAmountWithinCap(paid.amount_pln, config.max_pln);
  const output: FulfillmentOutput = {
    order_id: paid.order_id,
    status: paid.status,
    amount_pln: paid.amount_pln,
    note,
    photo_sha256: sha256File(options.proofFile),
    job_kind: config.job_kind,
    adapter: config.adapter,
    city: config.city,
    completed_at: new Date().toISOString(),
  };
  writeJson("fulfillment.json", output);
  return output;
}

export function finalizeFromPaidFile(
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): FulfillmentOutput {
  const paid = validatePaidOutput(readJson<unknown>("paid.json"));
  const output = writeFulfillment(paid, config, options, note);
  const proofPath = options.proofFile
    ? resolve(options.proofFile)
    : "/absolute/path/to/proof-photo.jpg";
  if (options.proofFile && !existsSync(proofPath)) {
    throw new Error(`PROOF_FILE does not exist: ${proofPath}`);
  }
  console.log(`Fulfillment written for order ${output.order_id}.`);
  console.log("Resume the Solana demo with:");
  console.log(
    `LIVE_DEMO=1 PROOF_FILE=${JSON.stringify(proofPath)} yarn demo:surfpool`,
  );
  return output;
}
