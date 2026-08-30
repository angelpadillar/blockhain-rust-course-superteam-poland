import { loadConfig, loadRuntimeOptions } from "./config.js";
import { readJson } from "./files.js";
import { pollForOtp } from "./mail.js";
import type { PaymentAttemptArtifact } from "./types.js";

interface CardAttemptStart {
  status: "started" | "auth_pending";
  started_at: string;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const options = loadRuntimeOptions();
  if (!options.allowPay || !options.allowThreeDsSubmit) {
    throw new Error(
      "3ds:poll requires ALLOW_PAY=true and ALLOW_3DS_SUBMIT=true",
    );
  }
  const attempt = readJson<CardAttemptStart>("card-attempt.json");
  if (attempt.status !== "started" && attempt.status !== "auth_pending") {
    throw new Error("there is no active card attempt awaiting 3DS");
  }
  const startedAt = new Date(attempt.started_at);
  if (Number.isNaN(startedAt.valueOf())) {
    throw new Error("card-attempt.json has an invalid start time");
  }
  const paymentAttempt = readJson<PaymentAttemptArtifact>(
    "payment-attempt.json",
  );
  const otp = await pollForOtp(options, startedAt, config);
  if (
    otp.currency !== paymentAttempt.currency ||
    Math.round(otp.amount * 100) !== paymentAttempt.amount_minor
  ) {
    throw new Error(
      "validated OTP does not match the on-chain payment attempt",
    );
  }
  console.log(
    `Fresh ${otp.provider} payment challenge validated for ${otp.amount.toFixed(2)} ${otp.currency}.`,
  );
  console.log(
    "OTP stored locally without printing it. Submission still requires 3ds:approve.",
  );
}

main().catch((error: unknown) => {
  console.error(`3DS POLL HARD FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
});
