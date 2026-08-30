import { specHash } from "./config.js";
import type { AgentConfig, QuoteOutput, QuoteSla } from "./types.js";

function parsePolishNumber(value: string): number {
  const normalized = value
    .replace(/\s/g, "")
    .replace(/,(?=\d{2}\b)/, ".")
    .replace(/[^\d.]/g, "");
  return Number.parseFloat(normalized);
}

function labelledAmount(lines: string[], label: RegExp): number | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!label.test(line)) continue;
    const amountPattern =
      /(?:PLN\s*(\d{1,4}(?:[.,]\d{2})?)|(\d{1,4}(?:[.,]\d{2})?)\s*(?:PLN|zł))/gi;
    let matches = [
      ...line.matchAll(
        /(?:PLN\s*(\d{1,4}(?:[.,]\d{2})?)|(\d{1,4}(?:[.,]\d{2})?)\s*(?:PLN|zł))/gi,
      ),
    ];
    if (matches.length === 0) {
      matches = [...(lines[index + 1] ?? "").matchAll(amountPattern)];
    }
    // Fee labels may include a parenthetical cap before the actual charge,
    // e.g. "Service fee 5.5% (max 3.99 zł) 2.29 zł". The row charge is the
    // final currency amount in the labelled row/window.
    const match = matches.at(-1);
    const captured = match?.[1] ?? match?.[2];
    if (!captured) continue;
    const amount = parsePolishNumber(captured);
    if (Number.isFinite(amount)) return amount;
  }
  return null;
}

export function parseCheckoutTotal(text: string): number {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/\b(total|łącznie|suma|razem|do zapłaty)\b/i.test(line)) continue;
    const window = [line, lines[index + 1] ?? ""].join(" ");
    const match = window.match(
      /(?:PLN\s*(\d{1,4}(?:[.,]\d{2})?)|(\d{1,4}(?:[.,]\d{2})?)\s*(?:PLN|zł))/i,
    );
    const captured = match?.[1] ?? match?.[2];
    if (captured) {
      const amount = parsePolishNumber(captured);
      if (Number.isFinite(amount)) return amount;
    }
  }
  throw new Error(
    "could not identify a labelled Total/Łącznie/Suma/Razem amount in PLN",
  );
}

export function parseCheckoutBreakdown(
  text: string,
  total: number,
): NonNullable<QuoteOutput["breakdown_pln"]> {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const smallOrderFee =
    labelledAmount(lines, /small.?order|mał(?:e|ego).*zamów/i) ?? 0;
  const serviceFee = labelledAmount(lines, /service fee|opłat.*serwis/i) ?? 0;
  const deliveryFee = labelledAmount(lines, /delivery(?: fee)?|dostaw/i) ?? 0;
  const tip = labelledAmount(lines, /^(?:courier )?tip|napiwek/i) ?? 0;
  const visibleSubtotal = labelledAmount(
    lines,
    /^(?:item |product )?subtotal|^products?$|^items?$|wartość produktów|podsuma/i,
  );
  const knownFees = smallOrderFee + serviceFee + deliveryFee + tip;
  const itemSubtotal = visibleSubtotal ?? total - knownFees;
  const otherFees = total - itemSubtotal - knownFees;
  if (itemSubtotal < -0.001 || otherFees < -0.011) {
    throw new Error("checkout fee components exceed the labelled final total");
  }
  const rounded = (value: number): number => Math.round(value * 100) / 100;
  return {
    item_subtotal: rounded(itemSubtotal),
    small_order_fee: rounded(smallOrderFee),
    service_fee: rounded(serviceFee),
    delivery_fee: rounded(deliveryFee),
    tip: rounded(tip),
    other_fees: rounded(Math.max(0, otherFees)),
  };
}

export function buildQuote(
  config: AgentConfig,
  note: string,
  landedPln: number | null,
  sourceUrl: string | null,
  sla: QuoteSla,
): QuoteOutput {
  return {
    job_kind: config.job_kind,
    adapter: config.adapter,
    landed_pln: landedPln,
    max_pln: config.max_pln,
    note,
    spec_hash: specHash(config),
    venue_label: config.venue_label,
    sla,
    city: config.city,
    currency: "PLN",
    currency_exponent: 2,
    charge_currency: landedPln === null ? null : "PLN",
    charge_currency_exponent: landedPln === null ? null : 2,
    charge_amount: landedPln,
    settlement_units_per_charge_unit: landedPln === null ? null : 1,
    pln_per_charge_unit: landedPln === null ? null : 1,
    source_url: sourceUrl,
    captured_at: new Date().toISOString(),
  };
}
