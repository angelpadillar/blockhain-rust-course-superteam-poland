import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadRuntimeOptions } from "./config.js";
import { outputPath } from "./files.js";
import { classifyMail, parsePaymentThreeDs } from "./otp.js";

function main(): void {
  const options = loadRuntimeOptions();
  if (options.allowPay || options.allowThreeDsSubmit) {
    throw new Error(
      "OTP dry run requires ALLOW_PAY=false and ALLOW_3DS_SUBMIT=false",
    );
  }

  const inputPath = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : outputPath("otp.json");
  const contents = readFileSync(inputPath, "utf8");
  let classification = "unknown";
  let parsed: ReturnType<typeof parsePaymentThreeDs> | null = null;

  try {
    const json = JSON.parse(contents) as Record<string, unknown>;
    if (
      json.kind === "payment_3ds" &&
      json.provider === "apata" &&
      json.from === "no-reply@apata.io"
    ) {
      classification = "payment_3ds";
    } else if (json.kind === "altitude_login_otp") {
      classification = "altitude_login_otp";
    }
  } catch {
    classification = classifyMail(contents);
    if (classification === "payment_3ds") {
      parsed = parsePaymentThreeDs(contents);
    }
  }

  console.log(`classification=${classification}`);
  if (classification === "altitude_login_otp") {
    throw new Error("Altitude login OTP rejected: never valid for payment 3DS");
  }
  if (classification !== "payment_3ds") {
    throw new Error(
      "Unknown handoff rejected. Use the raw Apata fixture so the sender can be classified.",
    );
  }
  if (parsed) {
    console.log(
      JSON.stringify(
        {
          provider: parsed.provider,
          currency: parsed.currency,
          amount: parsed.amount,
          merchant: parsed.merchant,
          otp: parsed.otp,
          from: parsed.from,
        },
        null,
        2,
      ),
    );
  }
  console.log("SUBMISSION BLOCKED: ALLOW_3DS_SUBMIT=false");
  console.log("No browser, mailbox, Nango, card, or payment action was used.");
}

try {
  main();
} catch (error) {
  console.error(`DRY RUN FAIL CLOSED: ${(error as Error).message}`);
  process.exitCode = 1;
}
