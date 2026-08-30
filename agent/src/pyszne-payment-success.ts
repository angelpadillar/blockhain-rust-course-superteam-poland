import { createHash } from "node:crypto";
import {
  buildPaymentAuthArtifact,
  buildPurchaseArtifact,
  recordPaymentAuthOnChain,
  recordPurchaseOnChain,
} from "./chain.js";
import {
  loadConfig,
  loadRuntimeOptions,
  renderNote,
} from "./config.js";
import { writeFulfillment, validatePaidOutput } from "./finalize.js";
import { readJson, writeJson } from "./files.js";
import { validatePaymentThreeDs } from "./otp.js";
import { finishSingleCardAttempt } from "./policy.js";
import type {
  OtpOutput,
  PaidOutput,
  QuoteOutput,
  ThreeDsAudit,
} from "./types.js";

interface AttemptRecord {
  status: "auth_pending" | "success";
  started_at?: string;
}

interface SubmitApproval {
  status: "approved_for_existing_browser_challenge";
  otp_sha256: string;
  currency: string;
  amount: number;
  merchant: string;
  provider: "apata";
  approved_at: string;
  expires_at: string;
}

interface MerchantSuccessEvidence {
  status: "merchant_confirmed";
  order_id: string;
  amount_pln: number;
  source_url: string;
  confirmed_at: string;
}

function validateMerchantSuccessEvidence(
  value: MerchantSuccessEvidence,
  paid: PaidOutput,
): MerchantSuccessEvidence {
  if (value.status !== "merchant_confirmed") {
    throw new Error("payment-success.json is not merchant-confirmed");
  }
  const url = new URL(value.source_url);
  if (
    url.hostname !== "www.pyszne.pl" ||
    !url.pathname.startsWith("/en/foodtracker/") ||
    url.searchParams.get("paymentStatus") !== "success"
  ) {
    throw new Error("payment-success.json is not a Pyszne success return");
  }
  if (
    value.order_id !== paid.order_id ||
    Math.abs(value.amount_pln - paid.amount_pln) > 0.005
  ) {
    throw new Error("merchant success evidence does not match paid.json");
  }
  if (Number.isNaN(new Date(value.confirmed_at).valueOf())) {
    throw new Error("merchant success confirmation timestamp is invalid");
  }
  return value;
}

function validateSubmitApproval(
  approval: SubmitApproval,
  otp: OtpOutput,
): void {
  if (approval.status !== "approved_for_existing_browser_challenge") {
    throw new Error("3DS submission was not explicitly approved");
  }
  const approvedAt = new Date(approval.approved_at);
  const expiresAt = new Date(approval.expires_at);
  if (
    Number.isNaN(approvedAt.valueOf()) ||
    Number.isNaN(expiresAt.valueOf()) ||
    approvedAt > expiresAt
  ) {
    throw new Error("3DS submission approval timestamps are invalid");
  }
  const otpHash = createHash("sha256").update(otp.otp).digest("hex");
  if (
    approval.otp_sha256 !== otpHash ||
    approval.currency !== otp.currency ||
    Math.abs(approval.amount - otp.amount) > 0.005 ||
    approval.merchant !== otp.merchant ||
    approval.provider !== otp.provider
  ) {
    throw new Error("3DS submission approval does not match the validated OTP");
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const options = loadRuntimeOptions();
  if (!options.allowPay || !options.allowThreeDsSubmit) {
    throw new Error(
      "success recording requires ALLOW_PAY=true and ALLOW_3DS_SUBMIT=true",
    );
  }
  if (config.adapter !== "pyszne") {
    throw new Error("success recording is restricted to the Pyszne adapter");
  }

  const attempt = readJson<AttemptRecord>("card-attempt.json");
  if (attempt.status !== "auth_pending" || !attempt.started_at) {
    throw new Error(
      "the one-attempt marker is not an unresolved Pyszne 3DS challenge",
    );
  }
  const startedAt = new Date(attempt.started_at);
  if (Number.isNaN(startedAt.valueOf())) {
    throw new Error("card-attempt.json has an invalid start time");
  }

  const quote = readJson<QuoteOutput>("quote.json");
  const paid = validatePaidOutput(readJson<unknown>("paid.json"));
  const success = validateMerchantSuccessEvidence(
    readJson<MerchantSuccessEvidence>("payment-success.json"),
    paid,
  );
  const otp = validatePaymentThreeDs(
    readJson<OtpOutput>("otp.json"),
    config,
    quote,
    new Date(startedAt.valueOf() - 5_000),
  );
  validateSubmitApproval(
    readJson<SubmitApproval>("3ds-submit-approval.json"),
    otp,
  );

  if (
    quote.landed_pln === null ||
    Math.abs(paid.amount_pln - quote.landed_pln) > 0.005
  ) {
    throw new Error("merchant-confirmed amount does not match quote.json");
  }

  const audit: ThreeDsAudit = {
    provider: "apata",
    mode: "email_otp_submitted",
    currency: otp.currency,
    amount: otp.amount,
    merchant: otp.merchant,
    from: otp.from,
    completed_at: success.confirmed_at,
  };
  writeJson("three-ds-audit.json", audit);
  writeFulfillment(
    paid,
    config,
    options,
    renderNote(config.note, options.nonce),
  );

  // Merchant success is definitive even if local Surfpool recording fails.
  // Close the card attempt before making any non-card follow-up calls so the
  // one-attempt guard can never interpret a chain error as permission to retry.
  finishSingleCardAttempt("success", `merchant confirmed order ${paid.order_id}`);
  writeJson("last-run.json", {
    status: "paid",
    order_id: paid.order_id,
    amount_pln: paid.amount_pln,
    confirmed_at: success.confirmed_at,
  });

  const auth = buildPaymentAuthArtifact(quote, audit);
  const authResult = recordPaymentAuthOnChain(options, auth);
  const purchase = buildPurchaseArtifact(quote, paid, otp.merchant);
  const purchaseResult = recordPurchaseOnChain(options, purchase);
  writeJson("payment-success-recording.json", {
    status: "purchased",
    order_id: paid.order_id,
    amount_pln: paid.amount_pln,
    payment_auth_signature: authResult.signature,
    purchase_signature: purchaseResult.signature,
    recorded_at: new Date().toISOString(),
  });

  console.log(
    `Pyszne order ${paid.order_id} confirmed paid at ${paid.amount_pln.toFixed(2)} PLN.`,
  );
  console.log(
    `Payment authentication committed on-chain: ${String(authResult.signature)}.`,
  );
  console.log(
    `Purchase committed on-chain: ${String(purchaseResult.signature)}.`,
  );
  console.log("The OTP and card fields were not printed.");
}

main().catch((error: unknown) => {
  console.error(
    `PYSZNE SUCCESS RECORDING HARD FAIL: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
