import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadRuntimeOptions } from "./config.js";
import { readJson, writeJson } from "./files.js";
import {
  reconcileSingleCardAttemptNoCharge,
  type CardAttemptRecord,
} from "./policy.js";

async function main(): Promise<void> {
  const options = loadRuntimeOptions();
  if (options.allowPay || options.allowThreeDsSubmit) {
    throw new Error(
      "payment:reconcile requires ALLOW_PAY=false and ALLOW_3DS_SUBMIT=false",
    );
  }
  const attempt = readJson<CardAttemptRecord>("card-attempt.json");
  if (
    (attempt.status !== "auth_pending" && attempt.status !== "hard_fail") ||
    !attempt.last4 ||
    attempt.amount_pln === undefined
  ) {
    throw new Error(
      "payment:reconcile requires an auth_pending or hard_fail card attempt with amount and last four",
    );
  }

  console.log("PAYMENT ATTEMPT RECONCILIATION");
  console.log(`Amount: ${attempt.amount_pln.toFixed(2)} PLN`);
  console.log(`Card: **** ${attempt.last4}`);
  console.log(
    "Check both the Altitude card activity and Pyszne order history before continuing.",
  );
  console.log(
    "This command records a human-observed no-charge result. It does not query or alter either service.",
  );
  const phrase = `CONFIRM NO CHARGE ${attempt.amount_pln.toFixed(2)} ${attempt.last4}`;
  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question(`Type ${phrase}: `);
  readline.close();
  if (answer !== phrase) {
    throw new Error("no-charge reconciliation confirmation did not match");
  }

  const reconciledAt = new Date().toISOString();
  reconcileSingleCardAttemptNoCharge(
    "Human confirmed no pending or completed charge in Altitude and no confirmed Pyszne order.",
  );
  writeJson("payment-reconciliation.json", {
    status: "human_confirmed_no_charge",
    amount_pln: attempt.amount_pln,
    card_last4: attempt.last4,
    reconciled_at: reconciledAt,
  });
  console.log(
    "No-charge result recorded. The failed run may now be archived; it is never retried in place.",
  );
}

main().catch((error: unknown) => {
  console.error(`PAYMENT RECONCILIATION HARD FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
});
