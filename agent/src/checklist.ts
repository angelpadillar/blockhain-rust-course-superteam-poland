import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { configHash } from "./config.js";
import { writeJson } from "./files.js";
import { assertSecretPathsIgnored } from "./policy.js";
import type { AgentConfig, RuntimeOptions } from "./types.js";

function maskPhone(phone: string): string {
  const compact = phone.replace(/\s/g, "");
  if (compact.length <= 4) return "****";
  return `${"*".repeat(Math.min(compact.length - 4, 8))}${compact.slice(-4)}`;
}

export function renderChecklist(
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): string {
  const itemLines = config.spec
    ? `    - ${config.spec.qty} × ${config.spec.item}\n    - fallback: ${config.spec.text_fallback}`
    : config.selection
      ? [
          `    - the browser agent selects exact live products for ${config.selection.participants} people`,
          `    - exactly ${config.selection.milk_liters} L regular cow's milk at ${config.selection.milk_fat_percent}% fat`,
          `    - at least ${config.selection.beverage_servings_min} servings of 100% juice or office-safe functional drinks`,
          "    - at least one healthier snack line; no ordinary juice drinks, nectar, alcohol, or confectionery",
          "    - exact products, quantities, fees, and landed total require a second quote approval before Pay",
        ].join("\n")
      : config.items
          .map((item) => `    - ${item.qty} × ${item.query}`)
          .join("\n");
  const phone = config.phone ? ` (${maskPhone(config.phone)})` : "";
  return [
    "ONE-ORDER HUMAN CHECKLIST",
    `[ ] Job is ${config.job_kind} through adapter ${config.adapter}`,
    `[ ] Destination city is exactly ${config.city}`,
    `[ ] Destination type is explicitly ${config.destination_type}`,
    `[ ] Venue: ${config.venue_label}`,
    `[ ] Address: ${config.address_line}`,
    `[ ] Recipient: ${config.recipient_name}${phone}`,
    "[ ] Approved fulfillment spec:",
    itemLines,
    `[ ] Delivery note is exactly: ${JSON.stringify(note)}`,
    `[ ] Hard cart cap is ${config.max_pln.toFixed(2)} PLN`,
    `[ ] ALLOW_PAY=${String(options.allowPay)}`,
    `[ ] ALLOW_3DS_SUBMIT=${String(options.allowThreeDsSubmit)}`,
    `[ ] ALLOW_SAVE_CARD=${String(options.allowSaveCard)}`,
    `[ ] Card rail is ${options.cardRail}; cap is managed outside this repository`,
    options.allowSaveCard
      ? "[ ] This run allows Glovo to save the card as the account default"
      : "[ ] No card will be saved by the merchant",
    "[ ] This is one order and one card attempt only",
  ].join("\n");
}

export async function runChecklist(
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): Promise<void> {
  assertSecretPathsIgnored();
  console.log(renderChecklist(config, options, note));
  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question(
    "\nType CONFIRM ONE ORDER to create the local approval artifact: ",
  );
  readline.close();
  if (answer !== "CONFIRM ONE ORDER") {
    throw new Error(
      "checklist was not confirmed; browser and payment remain blocked",
    );
  }
  writeJson("human-confirmation.json", {
    config_sha256: configHash(config, note),
    confirmed_at: new Date().toISOString(),
    max_pln: config.max_pln,
    allow_pay: options.allowPay,
    allow_3ds_submit: options.allowThreeDsSubmit,
    allow_save_card: options.allowSaveCard,
  });
  console.log("Checklist confirmed locally. No browser was opened.");
}
