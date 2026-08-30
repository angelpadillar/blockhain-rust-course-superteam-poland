import { existsSync, readFileSync, statSync } from "node:fs";
import { outputPath, readJson, writeJson } from "./files.js";
import { readFreshAgentMailOtp } from "./agentmail.js";
import { parsePaymentThreeDs, validatePaymentThreeDs } from "./otp.js";
import { markSingleCardAttemptAuthPending } from "./policy.js";
import type {
  AgentConfig,
  OtpOutput,
  QuoteOutput,
  RuntimeOptions,
} from "./types.js";

const OTP_TIMEOUT_MS = 120_000;

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function pollForOtp(
  options: RuntimeOptions,
  attemptStartedAt: Date,
  config: AgentConfig,
): Promise<OtpOutput> {
  if (options.mailSource === "nango") {
    throw new Error(
      "No clean existing local Nango mail script was found, so Nango was not wired. Complete 3DS manually on the phone.",
    );
  }

  markSingleCardAttemptAuthPending(
    "3DS challenge is active; awaiting a fresh validated payment OTP. No second card submission is authorized.",
  );

  const otpPath = outputPath("otp.json");
  const quote = readJson<QuoteOutput>("quote.json");
  const notBefore = new Date(attemptStartedAt.valueOf() - 5_000);
  const deadline = Date.now() + OTP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (options.mailSource === "agentmail") {
      if (
        config.three_ds_email.toLocaleLowerCase() !== options.agentMailInbox
      ) {
        throw new Error(
          "AgentMail inbox must exactly match config.three_ds_email before 3DS polling",
        );
      }
      const handoff = await readFreshAgentMailOtp(options, notBefore);
      if (handoff) {
        const validated = validatePaymentThreeDs(
          handoff,
          config,
          quote,
          notBefore,
        );
        writeJson("otp.json", validated);
        return validated;
      }
      await wait(2_000);
      continue;
    }
    if (existsSync(otpPath)) {
      const contents = readFileSync(otpPath, "utf8");
      let value: unknown;
      try {
        value = JSON.parse(contents) as unknown;
      } catch {
        const modifiedAt = statSync(otpPath).mtime;
        if (modifiedAt < notBefore) {
          throw new Error(
            "raw OTP fixture was copied before the payment attempt and is stale",
          );
        }
        value = {
          ...parsePaymentThreeDs(contents),
          ts: modifiedAt.toISOString(),
        };
      }
      const validated = validatePaymentThreeDs(value, config, quote, notBefore);
      writeJson("otp.json", validated);
      return validated;
    }
    await wait(2_000);
  }
  throw new Error(
    "No OTP arrived within 120 seconds. Complete 3DS manually on the phone; the agent submitted no code.",
  );
}
