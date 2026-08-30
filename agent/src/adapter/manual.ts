import { writeFileSync } from "node:fs";
import { outputPath, writeJson } from "../files.js";
import { buildQuote } from "../quote.js";
import type { AgentConfig, QuoteOutput, RuntimeOptions } from "../types.js";
import type { FulfillmentAdapter } from "./types.js";

export function renderManualCall(
  config: AgentConfig,
  note: string,
  sourceUrl: string | null = null,
  phone: string | null = null,
): string {
  const spec = config.spec;
  return [
    "# Manual local fulfillment handoff",
    "",
    `- City: ${config.city}`,
    `- Venue: ${config.venue_label}`,
    `- Delivery or pickup: prefer pickup-at-shop; otherwise courier to venue`,
    `- Shop URL: ${sourceUrl ?? "TO BE SELECTED"}`,
    `- Shop phone: ${phone ?? "TO BE FOUND"}`,
    `- Quote ceiling: ${config.max_pln.toFixed(2)} PLN landed`,
    `- Same-day requirement: ${config.constraints.includes("same-day-or-fail") ? "required" : "ask"}`,
    `- Item: ${spec ? `${spec.qty} × ${spec.item}` : config.items.map((item) => `${item.qty} × ${item.query}`).join(", ")}`,
    `- Design: ${spec?.design_file ?? "none"}`,
    `- Text fallback: ${spec?.text_fallback ?? "none"}`,
    `- Exact note: ${note}`,
    "",
    "## Human checklist",
    "",
    "- [ ] Confirm the shop is in Kraków and the item is office-safe.",
    "- [ ] Confirm same-day pickup or delivery to the configured venue.",
    "- [ ] Record the full landed PLN quote before approving work.",
    `- [ ] Abort if the quote is above ${config.max_pln.toFixed(2)} PLN.`,
    "- [ ] Do not save a card and do not retry a failed card attempt.",
    "",
    "Ask for the full landed PLN price and confirmation it is ready today.",
    "Do not approve production or payment above max_pln.",
    "Do not use China, overseas, Printful, AliExpress, or multi-week fulfillment.",
  ].join("\n");
}

export class ManualAdapter implements FulfillmentAdapter {
  private output: QuoteOutput | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly options: RuntimeOptions,
    private readonly note: string,
    private readonly sourceUrl: string | null = null,
    private readonly phone: string | null = null,
  ) {}

  async searchOrOpen(): Promise<void> {}

  async buildCartOrOrderForm(): Promise<void> {
    writeFileSync(
      outputPath("manual_call.md"),
      `${renderManualCall(this.config, this.note, this.sourceUrl, this.phone)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async fillDestination(): Promise<void> {}
  async attachNote(): Promise<void> {}

  async quote(): Promise<QuoteOutput> {
    this.output = buildQuote(
      this.config,
      this.note,
      null,
      this.sourceUrl,
      "manual",
    );
    writeJson("quote.json", this.output);
    return this.output;
  }

  async stopAtPaywall(): Promise<void> {
    console.log("MANUAL FULFILLMENT HANDOFF");
    console.log(
      "See agent/out/manual_call.md. No form was submitted and no payment was attempted.",
    );
    if (this.options.allowPay) {
      console.log(
        "ALLOW_PAY=true does not authorize an unverified manual merchant payment.",
      );
    }
  }

  async close(): Promise<void> {}
}
