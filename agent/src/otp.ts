import type {
  AgentConfig,
  MailClassification,
  OtpOutput,
  PaymentCurrency,
  QuoteOutput,
} from "./types.js";

const APATA_SENDER = "no-reply@apata.io";
const ALTITUDE_LOGIN_SENDER = "notifications@altitude.squads.xyz";
const LANDED_BUFFER_PLN = 2;

function senderFromMail(text: string): string | null {
  const header = text.match(/^From:\s*(.+)$/im)?.[1]?.trim();
  if (!header) return null;
  const bracketed = header.match(/<([^>]+)>/)?.[1];
  const address = bracketed ?? header.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/i)?.[0];
  return address?.toLocaleLowerCase() ?? null;
}

function normalizeMerchant(value: string): string {
  return value.toLocaleUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function classifyMail(text: string): MailClassification {
  const from = senderFromMail(text);
  if (
    from === ALTITUDE_LOGIN_SENDER &&
    /continue\s+in\s+Altitude/i.test(text)
  ) {
    return "altitude_login_otp";
  }
  if (from === APATA_SENDER && /confirm\s+your\s+payment/i.test(text)) {
    return "payment_3ds";
  }
  return "unknown";
}

export function parsePaymentThreeDs(text: string): Omit<OtpOutput, "ts"> {
  const classification = classifyMail(text);
  if (classification === "altitude_login_otp") {
    throw new Error(
      "altitude_login_otp is an account-login code and must never be submitted as payment 3DS",
    );
  }
  if (classification !== "payment_3ds") {
    throw new Error(
      "unknown mail sender or message type; payment 3DS is blocked",
    );
  }

  const payment = text.match(
    /confirm\s+your\s+payment\s+of\s+([A-Z]{3})\s+(\d{1,9}(?:[.,]\d{1,4})?)\s+to\s+([A-Z0-9][A-Z0-9 ._*-]{0,39}?)\s+using\s+the\s+code\s+(\d{6})\b/i,
  );
  if (!payment?.[1] || !payment[2] || !payment[3] || !payment[4]) {
    throw new Error(
      "Apata payment email did not contain one unambiguous currency, amount, merchant, and 6-digit OTP",
    );
  }
  const amount = Number.parseFloat(payment[2].replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Apata payment amount is invalid");
  }
  return {
    kind: "payment_3ds",
    provider: "apata",
    currency: payment[1].toLocaleUpperCase() as PaymentCurrency,
    amount,
    merchant: payment[3].trim(),
    otp: payment[4],
    from: APATA_SENDER,
  };
}

function validateHandoffShape(value: unknown): OtpOutput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "otp.json must contain a payment_3ds object or a raw fixture",
    );
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "altitude_login_otp") {
    throw new Error(
      "altitude_login_otp is an account-login code and must never be submitted as payment 3DS",
    );
  }
  if (record.kind !== "payment_3ds" || record.provider !== "apata") {
    throw new Error("otp.json is not a recognized Apata payment_3ds handoff");
  }
  if (record.from !== APATA_SENDER) {
    throw new Error("otp.json.from must be no-reply@apata.io");
  }
  if (
    typeof record.currency !== "string" ||
    !/^[A-Z]{3}$/.test(record.currency)
  ) {
    throw new Error(
      "otp.json.currency must be a three-letter uppercase currency code",
    );
  }
  if (typeof record.amount !== "number" || !Number.isFinite(record.amount)) {
    throw new Error("otp.json.amount must be a finite number");
  }
  if (typeof record.merchant !== "string" || record.merchant.trim() === "") {
    throw new Error("otp.json.merchant must be a non-empty string");
  }
  if (typeof record.otp !== "string" || !/^\d{6}$/.test(record.otp)) {
    throw new Error("otp.json.otp must contain exactly 6 digits");
  }
  if (typeof record.ts !== "string" || record.ts.trim() === "") {
    throw new Error("otp.json.ts must be a timestamp");
  }
  return {
    kind: "payment_3ds",
    provider: "apata",
    currency: record.currency,
    amount: record.amount,
    merchant: record.merchant,
    otp: record.otp,
    from: APATA_SENDER,
    ts: record.ts,
  };
}

export function validatePaymentThreeDs(
  value: unknown,
  config: AgentConfig,
  quote: QuoteOutput,
  notBefore: Date,
): OtpOutput {
  const otp = validateHandoffShape(value);
  const timestamp = new Date(otp.ts);
  if (Number.isNaN(timestamp.valueOf()) || timestamp < notBefore) {
    throw new Error("otp.json is stale or has an invalid timestamp");
  }

  const allowedMerchants = new Set([
    normalizeMerchant("WOLT"),
    normalizeMerchant("WOLTPL"),
  ]);
  if (config.adapter === "glovo") {
    allowedMerchants.add(normalizeMerchant("GLOVO"));
    allowedMerchants.add(normalizeMerchant("GLOVOAPP"));
    allowedMerchants.add(normalizeMerchant("GLOVOPL"));
  }
  if (config.merchant_descriptor) {
    allowedMerchants.add(normalizeMerchant(config.merchant_descriptor));
  }
  if (!allowedMerchants.has(normalizeMerchant(otp.merchant))) {
    throw new Error(
      `payment merchant ${JSON.stringify(otp.merchant)} is not in the configured allowlist`,
    );
  }

  if (
    quote.charge_currency === null ||
    quote.charge_amount === null ||
    quote.settlement_units_per_charge_unit === null
  ) {
    throw new Error(
      "quote.json has no explicit card currency, amount, and settlement conversion; payment 3DS is blocked",
    );
  }
  if (otp.currency !== quote.charge_currency) {
    throw new Error(
      `payment currency ${otp.currency} does not match quoted currency ${quote.charge_currency}`,
    );
  }
  if (
    quote.charge_currency_exponent === null ||
    !Number.isInteger(quote.charge_currency_exponent) ||
    quote.charge_currency_exponent < 0 ||
    quote.charge_currency_exponent > 4
  ) {
    throw new Error("quote.json charge currency exponent is invalid");
  }
  const amountEpsilon = 0.5 / 10 ** quote.charge_currency_exponent;
  if (Math.abs(otp.amount - quote.charge_amount) > amountEpsilon) {
    throw new Error(
      `payment amount ${otp.amount.toFixed(2)} does not match quoted charge ${quote.charge_amount.toFixed(2)}`,
    );
  }
  if (
    !Number.isFinite(quote.settlement_units_per_charge_unit) ||
    quote.settlement_units_per_charge_unit <= 0
  ) {
    throw new Error("quote.json settlement conversion rate is invalid");
  }
  const convertedPln = otp.amount * quote.settlement_units_per_charge_unit;
  const hardCap = Math.min(config.max_pln, quote.max_pln);
  if (convertedPln > hardCap + 0.005) {
    throw new Error(
      `payment amount converts to ${convertedPln.toFixed(2)} PLN, above max_pln ${hardCap.toFixed(2)}`,
    );
  }
  if (
    quote.landed_pln === null ||
    convertedPln > quote.landed_pln + LANDED_BUFFER_PLN
  ) {
    throw new Error(
      "payment amount is above the quoted landed amount plus the 2.00 PLN buffer",
    );
  }
  return { ...otp, ts: timestamp.toISOString() };
}
