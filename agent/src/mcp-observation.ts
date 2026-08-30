import { createHash } from "node:crypto";
import { assertAmountWithinCap } from "./policy.js";
import { buildQuote } from "./quote.js";
import type { AgentConfig, QuoteOutput } from "./types.js";

export interface McpBrowserObservation {
  extracted_by: "mcp_visual";
  job_kind: "food";
  adapter: "wolt" | "glovo" | "pyszne";
  city: "Kraków";
  merchant: string;
  items: Array<{
    approved_query: string;
    visible_item: string;
    quantity: number;
  }>;
  address_street: string;
  recipient_name: string;
  note: string;
  destination_confirmed_at_quote: true;
  delivery_option: "standard";
  checkout_stage: "final_summary_before_payment_method";
  item_subtotal_pln: number;
  small_order_fee_pln: number;
  service_fee_pln: number;
  delivery_fee_pln: number;
  tip_pln: number;
  other_fees_pln: number;
  landed_pln: number;
  source_url: string;
  payment_method_opened: false;
  captured_at: string;
}

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pl-PL")
    .trim();
}

function assertRegularMilkItem(
  value: string,
  requireThreePointTwo: boolean,
): void {
  const item = fold(value);
  const forbidden =
    /bez laktozy|lactose[- ]?free|owsian|oat|soj|soy|migdal|almond|kokos|coconut|kozi|goat|proszk|powder|czekolad|chocolate|kakao|cocoa|wanili|vanilla|smak|flavou?r/;
  if (!/\b(?:mleko|milk)\b/.test(item) || forbidden.test(item)) {
    throw new Error(
      "MCP milk observation is not unflavoured regular cow's milk",
    );
  }
  if (!/\b1\s*(?:l|litr|liter)\b/.test(item)) {
    throw new Error("MCP milk observation is not a 1 L product");
  }
  const fatPattern = requireThreePointTwo
    ? /(?:^|\s)3[.,]2\s*%/
    : /(?:^|\s)(?:2(?:[.,]0)?|3[.,]2)\s*%/;
  if (!fatPattern.test(item)) {
    throw new Error(
      requireThreePointTwo
        ? "MCP milk observation is not exactly 3.2% fat"
        : "MCP milk observation is not 2% or 3.2% fat",
    );
  }
}

function isStandaloneMilkQuery(value: string): boolean {
  const query = fold(value);
  return (
    /\b(?:mleko|milk)\b/.test(query) &&
    !/chocolate|czekolad|bar|baton|cookie|ciast|candy/.test(query)
  );
}

function productPackCount(value: string): number {
  const normalized = fold(value);
  const match = normalized.match(/(?:\bx\s*(\d+)\b|\b(\d+)\s*x\b)/);
  return Number(match?.[1] ?? match?.[2] ?? 1);
}

function productVolumeLiters(value: string): number | null {
  const normalized = fold(value).replace(/,/g, ".");
  const liters = normalized.match(/\b(\d+(?:\.\d+)?)\s*l\b/);
  if (liters?.[1]) return Number(liters[1]);
  const milliliters = normalized.match(/\b(\d+(?:\.\d+)?)\s*ml\b/);
  if (milliliters?.[1]) return Number(milliliters[1]) / 1_000;
  return null;
}

function isApprovedCuratedBeverage(value: string): boolean {
  const item = fold(value);
  const juice = /\b(?:juice|sok)\b/.test(item) && /\b100\s*%/.test(item);
  const functional =
    /lion'?s mane|lion mane|soplow|mushroom|functional|adaptogen/.test(item) &&
    /drink|shot|energy|napoj/.test(item);
  const forbidden =
    /nectar|nektar|juice drink|napoj owocowy|alcohol|beer|piwo|wine|wino|vodka|wodka/;
  return (juice || functional) && !forbidden.test(item);
}

function isApprovedHealthySnack(value: string): boolean {
  const item = fold(value);
  const healthy =
    /nuts?|orzech|seeds?|nasion|dried fruit|suszon.*owoc|fresh fruit|owoc|banan|granola|wholegrain|pelnoziarn|rice cake|wafle ryz/;
  const confectionery =
    /chocolate|czekolad|candy|cukierk|mars\b|twix\b|kitkat|lion peanut|cookie|ciastk/;
  return healthy.test(item) && !confectionery.test(item);
}

function validateAgentCuratedSelection(
  config: AgentConfig,
  observed: McpBrowserObservation,
): void {
  const policy = config.selection;
  if (!policy) throw new Error("agent-curated selection policy is missing");
  if (observed.items.length < 3 || observed.items.length > 8) {
    throw new Error("agent-curated quote must contain 3 to 8 exact item lines");
  }
  let milkLiters = 0;
  let beverageServings = 0;
  let healthySnackLines = 0;
  for (const selected of observed.items) {
    if (
      !selected.visible_item.trim() ||
      !Number.isInteger(selected.quantity) ||
      selected.quantity < 1 ||
      selected.quantity > 12
    ) {
      throw new Error("agent-curated item has an invalid name or quantity");
    }
    const pack = productPackCount(selected.visible_item);
    const volume = productVolumeLiters(selected.visible_item);
    if (isStandaloneMilkQuery(selected.visible_item)) {
      assertRegularMilkItem(selected.visible_item, true);
      if (volume === null) {
        throw new Error("agent-curated milk has no visible volume");
      }
      milkLiters += volume * pack * selected.quantity;
      continue;
    }
    if (isApprovedCuratedBeverage(selected.visible_item)) {
      const units = pack * selected.quantity;
      beverageServings +=
        volume === null ? units : Math.max(units, volume * 4 * units);
      continue;
    }
    if (isApprovedHealthySnack(selected.visible_item)) {
      healthySnackLines += 1;
      continue;
    }
    throw new Error(
      `agent-curated item is not approved milk, beverage, or healthy snack: ${JSON.stringify(selected.visible_item)}`,
    );
  }
  if (Math.abs(milkLiters - policy.milk_liters) > 0.001) {
    throw new Error(
      `agent-curated selection must contain exactly ${policy.milk_liters} L of 3.2% milk`,
    );
  }
  if (beverageServings + 0.001 < policy.beverage_servings_min) {
    throw new Error(
      `agent-curated beverages cover ${beverageServings.toFixed(1)} servings, below ${policy.beverage_servings_min}`,
    );
  }
  if (policy.include_healthy_snacks && healthySnackLines < 1) {
    throw new Error("agent-curated selection has no approved healthy snack");
  }
}

function assertCheckoutSource(
  adapter: AgentConfig["adapter"],
  raw: string,
): void {
  const source = new URL(raw);
  if (source.protocol !== "https:") {
    throw new Error("MCP observation source must use HTTPS");
  }
  const host = source.hostname.toLocaleLowerCase();
  const valid =
    (adapter === "wolt" &&
      (host === "wolt.com" || host.endsWith(".wolt.com")) &&
      /checkout/i.test(source.pathname)) ||
    (adapter === "pyszne" &&
      (host === "pyszne.pl" || host.endsWith(".pyszne.pl")) &&
      /checkout/i.test(source.pathname)) ||
    (adapter === "glovo" &&
      (host === "glovoapp.com" || host.endsWith(".glovoapp.com")) &&
      /(?:checkout|order-summary)/i.test(`${source.pathname}${source.hash}`));
  if (!valid) {
    throw new Error(`MCP observation is not a ${adapter} checkout URL`);
  }
}

export function validateMcpBrowserObservation(
  config: AgentConfig,
  note: string,
  observed: McpBrowserObservation,
  notBefore: Date,
): QuoteOutput {
  if (
    observed.extracted_by !== "mcp_visual" ||
    observed.job_kind !== config.job_kind ||
    observed.adapter !== config.adapter ||
    observed.city !== config.city
  ) {
    throw new Error(
      "MCP browser observation does not match the configured job",
    );
  }
  if (
    observed.payment_method_opened !== false ||
    observed.destination_confirmed_at_quote !== true ||
    observed.delivery_option !== "standard" ||
    observed.checkout_stage !== "final_summary_before_payment_method"
  ) {
    throw new Error(
      "MCP quote was not captured at the final summary before payment method",
    );
  }
  const capturedAt = new Date(observed.captured_at);
  if (
    Number.isNaN(capturedAt.valueOf()) ||
    capturedAt < notBefore ||
    capturedAt.valueOf() > Date.now() + 60_000
  ) {
    throw new Error("MCP browser observation is stale or future-dated");
  }
  assertCheckoutSource(config.adapter, observed.source_url);
  if (!observed.merchant.trim()) throw new Error("MCP merchant is missing");

  if (config.selection) {
    validateAgentCuratedSelection(config, observed);
  } else {
    if (observed.items.length !== config.items.length) {
      throw new Error("MCP observation item count does not match approval");
    }
    for (const configured of config.items) {
      const match = observed.items.find(
        (item) => fold(item.approved_query) === fold(configured.query),
      );
      if (
        !match ||
        match.quantity !== configured.qty ||
        !fold(match.visible_item).includes(fold(configured.query))
      ) {
        throw new Error(
          `MCP observation does not match approved item ${JSON.stringify(configured.query)}`,
        );
      }
      const allowTwoOrThreePointTwo = config.constraints.includes(
        "regular-cow-milk-1l-2-or-3.2-percent",
      );
      const requireThreePointTwo = config.constraints.includes(
        "regular-cow-milk-1l-3.2-percent",
      );
      const configuredItemIsMilk = isStandaloneMilkQuery(configured.query);
      if (
        configuredItemIsMilk &&
        (allowTwoOrThreePointTwo || requireThreePointTwo)
      ) {
        assertRegularMilkItem(match.visible_item, requireThreePointTwo);
      }
    }
  }
  if (
    !fold(config.address_line).startsWith(fold(observed.address_street)) ||
    observed.recipient_name !== config.recipient_name ||
    observed.note !== note
  ) {
    throw new Error(
      "MCP observation does not match destination, recipient, or note",
    );
  }

  assertAmountWithinCap(observed.landed_pln, config.max_pln);
  const feeParts = [
    observed.item_subtotal_pln,
    observed.small_order_fee_pln,
    observed.service_fee_pln,
    observed.delivery_fee_pln,
    observed.tip_pln,
    observed.other_fees_pln,
  ];
  if (feeParts.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("MCP quote contains a missing or invalid fee component");
  }
  const calculated = feeParts.reduce((sum, value) => sum + value, 0);
  if (Math.abs(calculated - observed.landed_pln) > 0.01) {
    throw new Error(
      `MCP landed total ${observed.landed_pln.toFixed(2)} PLN does not equal components ${calculated.toFixed(2)} PLN`,
    );
  }
  const quote = buildQuote(
    config,
    note,
    observed.landed_pln,
    observed.source_url,
    "same-day",
  );
  if (config.selection) {
    quote.spec_hash = createHash("sha256")
      .update(
        JSON.stringify({
          selection: config.selection,
          constraints: config.constraints,
          exact_items: observed.items.map((item) => ({
            visible_item: item.visible_item,
            quantity: item.quantity,
          })),
        }),
      )
      .digest("hex");
  }
  quote.breakdown_pln = {
    item_subtotal: observed.item_subtotal_pln,
    small_order_fee: observed.small_order_fee_pln,
    service_fee: observed.service_fee_pln,
    delivery_fee: observed.delivery_fee_pln,
    tip: observed.tip_pln,
    other_fees: observed.other_fees_pln,
  };
  return quote;
}
