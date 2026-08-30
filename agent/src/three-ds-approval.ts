import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { verifyConfirmation } from "./browser.js";
import {
  loadConfig,
  loadRuntimeOptions,
  renderNote,
} from "./config.js";
import { readJson, writeJson } from "./files.js";
import { validatePaymentThreeDs } from "./otp.js";
import type { OtpOutput, QuoteOutput } from "./types.js";

interface CardAttemptMarker {
  status:
    | "started"
    | "auth_pending"
    | "success"
    | "hard_fail"
    | "reconciled_no_charge";
  started_at?: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const options = loadRuntimeOptions();
  const note = renderNote(config.note, options.nonce);
  if (!options.allowPay || !options.allowThreeDsSubmit) {
    throw new Error(
      "3ds:approve requires ALLOW_PAY=true and ALLOW_3DS_SUBMIT=true",
    );
  }
  verifyConfirmation(config, options, note);

  const attempt = readJson<CardAttemptMarker>("card-attempt.json");
  if (attempt.status !== "auth_pending" || !attempt.started_at) {
    throw new Error(
      "there is no auth_pending one-attempt payment to authenticate",
    );
  }
  const startedAt = new Date(attempt.started_at);
  if (Number.isNaN(startedAt.valueOf())) {
    throw new Error("card-attempt.json has an invalid start time");
  }
  const quote = readJson<QuoteOutput>("quote.json");
  const otp = validatePaymentThreeDs(
    readJson<OtpOutput>("otp.json"),
    config,
    quote,
    new Date(startedAt.valueOf() - 5_000),
  );

  console.log("IMMEDIATE 3DS SUBMISSION APPROVAL");
  console.log(`Merchant: ${otp.merchant}`);
  console.log(`Amount: ${otp.amount.toFixed(2)} ${otp.currency}`);
  console.log(`Provider: ${otp.provider}`);
  console.log("The OTP is validated but will not be printed.");
  console.log("The existing browser challenge must still be visible.");
  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question("Type SUBMIT OTP to continue: ");
  readline.close();
  if (answer !== "SUBMIT OTP") {
    throw new Error("3DS submission approval did not match; code not approved");
  }

  const approvedAt = new Date();
  writeJson("3ds-submit-approval.json", {
    status: "approved_for_existing_browser_challenge",
    otp_sha256: createHash("sha256").update(otp.otp).digest("hex"),
    currency: otp.currency,
    amount: otp.amount,
    merchant: otp.merchant,
    provider: otp.provider,
    approved_at: approvedAt.toISOString(),
    expires_at: new Date(approvedAt.valueOf() + 120_000).toISOString(),
  });
  console.log(
    "3DS submission approved for the currently open challenge only. The OTP was not printed.",
  );
}

main().catch((error: unknown) => {
  console.error(`3DS APPROVAL HARD FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
});
