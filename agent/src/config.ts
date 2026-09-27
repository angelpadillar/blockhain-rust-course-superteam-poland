import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import dotenv from "dotenv";
import { readFulfillmentCardFile } from "./order/secrets.js";
import { agentRoot, configPath, envPath } from "./paths.js";
import type {
  AdapterName,
  AgentSelectionPolicy,
  AgentConfig,
  CardSecrets,
  FulfillmentItem,
  FulfillmentSpec,
  JobKind,
  RuntimeOptions,
} from "./types.js";

const FULFILLMENT_AGENTMAIL_INBOX = "fulfillment-demo@mail.buena.ai";

const SAFE_FOOD_TERMS = [
  "sernik",
  "pastry",
  "pastries",
  "ciastko",
  "ciastka",
  "cake",
  "croissant",
  "rogalik",
  "pączek",
  "paczek",
  "paczki",
  "snack",
  "snacks",
  "drożdżówka",
  "drozdzowka",
  "donut",
  "muffin",
  "brownie",
  "cookie",
  "bar",
  "baton",
  "milk",
  "mleko",
  "juice",
  "sok",
  "fruit",
  "owoc",
  "nuts",
  "orzech",
  "seeds",
  "nasion",
  "granola",
  "wholegrain",
  "pełnoziarn",
];
const SAFE_MERCH_TERMS = [
  "print",
  "nadruk",
  "druk",
  "tote",
  "torba",
  "t-shirt",
  "tee",
  "shirt",
  "koszul",
  "sticker",
  "naklejk",
  "dtf",
  "sitodruk",
];
const BANNED_FOOD_TERMS = [
  "alcohol",
  "cigarette",
  "papieros",
  "vape",
  "medicine",
];
const BANNED_FOOD_PATTERNS = [
  /\b(?:beer|piwo|vodka|wódka|wine|wino)\b/u,
  /\b(?:lek|leki|lekarstwo|lekarstwa)\b/u,
];
const OVERSEAS_OR_SLOW_TERMS = [
  "aliexpress",
  "alibaba",
  "temu",
  "printful",
  "printify",
  "china",
  "chiny",
  "overseas",
  "ocean freight",
  "multi-day ocean",
  "sea freight",
  "factory overseas",
  "dropship",
  "multi-week",
  "multi week",
  "wiele tygodni",
];
const JOB_KINDS = new Set<JobKind>(["food", "merch", "handmade", "generic"]);
const ADAPTERS = new Set<AdapterName>([
  "wolt",
  "glovo",
  "pyszne",
  "local_print",
  "local_shop",
  "manual",
]);

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (/REPLACE_ME/i.test(value))
    throw new Error(`${label} is still REPLACE_ME`);
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return expectString(value, label);
}

function parseItem(value: unknown, index: number): FulfillmentItem {
  const record = expectRecord(value, `items[${index}]`);
  const query = expectString(record.query, `items[${index}].query`);
  const normalized = query.toLocaleLowerCase("pl-PL");
  if (
    BANNED_FOOD_TERMS.some((term) => normalized.includes(term)) ||
    BANNED_FOOD_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    throw new Error(`items[${index}] is not an allowed food/grocery query`);
  }
  if (!SAFE_FOOD_TERMS.some((term) => normalized.includes(term))) {
    throw new Error(
      `items[${index}] must clearly name an approved pastry, snack, or grocery staple; query was ${JSON.stringify(query)}`,
    );
  }
  const qty = expectNumber(record.qty, `items[${index}].qty`);
  if (!Number.isInteger(qty) || qty < 1 || qty > 4) {
    throw new Error(`items[${index}].qty must be an integer from 1 to 4`);
  }
  return { query, qty };
}

function parseSpec(
  value: unknown,
  requireMerchTerms: boolean,
): FulfillmentSpec {
  const record = expectRecord(value, "spec");
  const item = expectString(record.item, "spec.item");
  const normalized = item.toLocaleLowerCase("pl-PL");
  if (
    requireMerchTerms &&
    !SAFE_MERCH_TERMS.some((term) => normalized.includes(term))
  ) {
    throw new Error(
      "spec.item must identify local-print merch such as a sticker, tote, tee, DTF, or screen print",
    );
  }
  const qty = expectNumber(record.qty, "spec.qty");
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
    throw new Error("spec.qty must be an integer from 1 to 10");
  }
  const note = expectString(record.note, "spec.note");
  if (note.length > 100)
    throw new Error("spec.note must be at most 100 characters");
  return {
    item,
    design_file: optionalString(record.design_file, "spec.design_file"),
    text_fallback: expectString(record.text_fallback, "spec.text_fallback"),
    qty,
    note,
  };
}

function parseStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => expectString(entry, `${label}[${index}]`));
}

function parseAgentSelection(value: unknown): AgentSelectionPolicy {
  const record = expectRecord(value, "selection");
  if (record.mode !== "agent_curated") {
    throw new Error("selection.mode must be agent_curated");
  }
  const participants = expectNumber(
    record.participants,
    "selection.participants",
  );
  const milkLiters = expectNumber(record.milk_liters, "selection.milk_liters");
  const beverageServings = expectNumber(
    record.beverage_servings_min,
    "selection.beverage_servings_min",
  );
  if (
    !Number.isInteger(participants) ||
    participants < 1 ||
    participants > 20
  ) {
    throw new Error("selection.participants must be an integer from 1 to 20");
  }
  if (milkLiters !== 2 || record.milk_fat_percent !== 3.2) {
    throw new Error("this demo selection requires exactly 2 L of 3.2% milk");
  }
  if (
    !Number.isInteger(beverageServings) ||
    beverageServings < participants ||
    beverageServings > 20
  ) {
    throw new Error(
      "selection.beverage_servings_min must cover every participant",
    );
  }
  if (
    record.allow_100_percent_juice !== true ||
    record.allow_office_safe_functional_drinks !== true ||
    record.include_healthy_snacks !== true
  ) {
    throw new Error(
      "agent-curated selection must allow 100% juice, office-safe functional drinks, and healthy snacks",
    );
  }
  return {
    mode: "agent_curated",
    participants,
    milk_liters: 2,
    milk_fat_percent: 3.2,
    beverage_servings_min: beverageServings,
    allow_100_percent_juice: true,
    allow_office_safe_functional_drinks: true,
    include_healthy_snacks: true,
  };
}

export function assertNoOverseasOrSlowFulfillment(config: AgentConfig): void {
  const policyText = JSON.stringify({
    job_kind: config.job_kind,
    adapter: config.adapter,
    spec: config.spec,
    constraints: config.constraints,
  }).toLocaleLowerCase("pl-PL");
  const match = OVERSEAS_OR_SLOW_TERMS.find((term) =>
    policyText.includes(term),
  );
  if (match) {
    throw new Error(
      `overseas factory or multi-week fulfillment is forbidden for this PoC (matched ${JSON.stringify(match)})`,
    );
  }
}

export function validateConfig(value: unknown): AgentConfig {
  const record = expectRecord(value, "config");
  const city = expectString(record.city, "city");
  if (city.toLocaleLowerCase("pl-PL") !== "kraków") {
    throw new Error(
      `destination city must be Kraków for this PoC; received ${city}`,
    );
  }
  if (!JOB_KINDS.has(record.job_kind as JobKind)) {
    throw new Error("job_kind must be food, merch, handmade, or generic");
  }
  if (!ADAPTERS.has(record.adapter as AdapterName)) {
    throw new Error(
      "adapter must be wolt, glovo, pyszne, local_print, local_shop, or manual",
    );
  }
  const jobKind = record.job_kind as JobKind;
  const adapter = record.adapter as AdapterName;
  if (
    (adapter === "wolt" || adapter === "glovo" || adapter === "pyszne") &&
    jobKind !== "food"
  )
    throw new Error(`the ${adapter} adapter is food-only`);
  if (adapter === "local_print" && jobKind !== "merch")
    throw new Error("the local_print adapter is merch-only");

  const destinationType = record.destination_type ?? "venue";
  if (destinationType !== "venue" && destinationType !== "home") {
    throw new Error("destination_type must be venue or home");
  }
  const addressLine = expectString(record.address_line, "address_line");
  if (!addressLine.toLocaleLowerCase("pl-PL").includes("kraków")) {
    throw new Error(
      "address_line must explicitly include Kraków so the city guard can fail closed",
    );
  }
  const maxPln = expectNumber(record.max_pln, "max_pln");
  if (maxPln <= 0 || maxPln > 200) {
    throw new Error("max_pln must be greater than 0 and no more than 200 PLN");
  }
  const contactEmail = expectString(record.contact_email, "contact_email");
  if (!/^\S+@\S+\.\S+$/.test(contactEmail))
    throw new Error("contact_email is invalid");
  const threeDsEmail =
    optionalString(record.three_ds_email, "three_ds_email") ?? contactEmail;
  if (!/^\S+@\S+\.\S+$/.test(threeDsEmail))
    throw new Error("three_ds_email is invalid");

  const constraints = parseStringArray(record.constraints, "constraints");
  let spec: FulfillmentSpec | null = null;
  let items: FulfillmentItem[] = [];
  let selection: AgentSelectionPolicy | null = null;
  let note: string;
  if (adapter === "wolt" || adapter === "glovo" || adapter === "pyszne") {
    if (record.selection !== undefined && record.selection !== null) {
      selection = parseAgentSelection(record.selection);
      if (
        record.items !== undefined &&
        (!Array.isArray(record.items) || record.items.length !== 0)
      ) {
        throw new Error(
          "agent-curated selection requires items to be omitted or empty before research",
        );
      }
      const requiredConstraints = [
        "agent-curated",
        "no-substitutions",
        "no-nectar-or-juice-drinks",
        "regular-cow-milk-1l-3.2-percent",
      ];
      for (const required of requiredConstraints) {
        if (!constraints.includes(required)) {
          throw new Error(
            `agent-curated selection requires constraint ${required}`,
          );
        }
      }
    } else {
      if (
        !Array.isArray(record.items) ||
        record.items.length < 1 ||
        record.items.length > 8
      ) {
        throw new Error(
          "items must contain 1 to 8 approved food/grocery entries",
        );
      }
      items = record.items.map(parseItem);
    }
    if (
      items.some((item) => /\b(?:milk|mleko)\b/i.test(item.query)) &&
      !constraints.includes("regular-cow-milk-1l-2-or-3.2-percent") &&
      !constraints.includes("regular-cow-milk-1l-3.2-percent")
    ) {
      throw new Error(
        "milk orders require an approved regular cow's milk constraint",
      );
    }
    note = expectString(record.note, "note");
  } else {
    spec = parseSpec(
      record.spec,
      adapter === "local_print" || jobKind === "merch",
    );
    note = spec.note;
    if (
      adapter === "local_print" &&
      !constraints.includes("same-day-or-fail")
    ) {
      throw new Error("local_print requires the same-day-or-fail constraint");
    }
  }
  if (note.length > 100) throw new Error("note must be at most 100 characters");
  const preferThreeDs = record.prefer_3ds_channel ?? "email";
  if (preferThreeDs !== "email")
    throw new Error("prefer_3ds_channel must be email");
  if (
    record.latlon_hint !== undefined &&
    record.latlon_hint !== null &&
    typeof record.latlon_hint !== "string"
  ) {
    throw new Error("latlon_hint must be a string or null");
  }

  const config: AgentConfig = {
    job_kind: jobKind,
    adapter,
    city: "Kraków",
    venue_label: expectString(record.venue_label, "venue_label"),
    destination_type: destinationType,
    address_line: addressLine,
    latlon_hint: (record.latlon_hint as string | null | undefined) ?? null,
    recipient_name: expectString(record.recipient_name, "recipient_name"),
    phone: optionalString(record.phone, "phone"),
    contact_email: contactEmail,
    three_ds_email: threeDsEmail,
    merchant_descriptor: optionalString(
      record.merchant_descriptor,
      "merchant_descriptor",
    ),
    spec,
    items,
    selection,
    note,
    max_pln: maxPln,
    constraints,
    prefer_3ds_channel: "email",
  };
  if (
    (adapter === "wolt" || adapter === "glovo" || adapter === "pyszne") &&
    !config.phone
  )
    throw new Error(`phone is required by the ${adapter} adapter`);
  assertNoOverseasOrSlowFulfillment(config);
  return config;
}

export function loadConfig(): AgentConfig {
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch {
    throw new Error(
      `Missing ${configPath}. Copy agent/config.example.json to agent/config.local.json and replace every REPLACE_ME value.`,
    );
  }
  return validateConfig(JSON.parse(contents) as unknown);
}

function envBoolean(name: string): boolean {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false")
    throw new Error(`${name} must be exactly true or false`);
  return value === "true";
}

function envSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 120 || value > 900) {
    throw new Error(`${name} must be an integer from 120 to 900 seconds`);
  }
  return value;
}

export function loadRuntimeOptions(): RuntimeOptions {
  dotenv.config({ path: envPath, quiet: true });
  const allowPay = envBoolean("ALLOW_PAY");
  const allowThreeDsSubmit = envBoolean("ALLOW_3DS_SUBMIT");
  const allowSaveCard = envBoolean("ALLOW_SAVE_CARD");
  if (allowThreeDsSubmit && !allowPay)
    throw new Error("ALLOW_3DS_SUBMIT=true requires ALLOW_PAY=true");
  if (allowSaveCard && !allowPay)
    throw new Error("ALLOW_SAVE_CARD=true requires ALLOW_PAY=true");
  const rawProfileDir =
    process.env.WOLT_PROFILE_DIR ?? "./agent/chrome-profile";
  const profileDir = isAbsolute(rawProfileDir)
    ? rawProfileDir
    : resolve(agentRoot, "..", rawProfileDir);
  const rawGlovoProfileDir =
    process.env.GLOVO_PROFILE_DIR ?? "./agent/glovo-profile";
  const glovoProfileDir = isAbsolute(rawGlovoProfileDir)
    ? rawGlovoProfileDir
    : resolve(agentRoot, "..", rawGlovoProfileDir);
  const rawPyszneProfileDir =
    process.env.PYSZNE_PROFILE_DIR ?? "./agent/pyszne-profile";
  const pyszneProfileDir = isAbsolute(rawPyszneProfileDir)
    ? rawPyszneProfileDir
    : resolve(agentRoot, "..", rawPyszneProfileDir);
  const mailSource = process.env.MAIL_SOURCE ?? "stub";
  if (
    mailSource !== "stub" &&
    mailSource !== "agentmail" &&
    mailSource !== "nango"
  )
    throw new Error("MAIL_SOURCE must be stub, agentmail, or nango");
  const agentMailInbox = (
    process.env.AGENTMAIL_INBOX ?? FULFILLMENT_AGENTMAIL_INBOX
  ).toLocaleLowerCase();
  if (agentMailInbox !== FULFILLMENT_AGENTMAIL_INBOX) {
    throw new Error(
      `AGENTMAIL_INBOX must be the dedicated fulfillment inbox ${FULFILLMENT_AGENTMAIL_INBOX}`,
    );
  }
  const agentMailApiKey = (process.env.AGENTMAIL_API_KEY ?? "").trim() || null;
  if (mailSource === "agentmail" && !agentMailApiKey) {
    throw new Error(
      "MAIL_SOURCE=agentmail requires AGENTMAIL_API_KEY in agent/.env",
    );
  }
  const woltLoginMode = process.env.WOLT_LOGIN_MODE ?? "manual";
  if (woltLoginMode !== "manual" && woltLoginMode !== "agentmail") {
    throw new Error("WOLT_LOGIN_MODE must be manual or agentmail");
  }
  if (woltLoginMode === "agentmail" && mailSource !== "agentmail") {
    throw new Error("WOLT_LOGIN_MODE=agentmail requires MAIL_SOURCE=agentmail");
  }
  const pyszneLoginMode = process.env.PYSZNE_LOGIN_MODE ?? "manual";
  if (pyszneLoginMode !== "manual" && pyszneLoginMode !== "agentmail") {
    throw new Error("PYSZNE_LOGIN_MODE must be manual or agentmail");
  }
  if (pyszneLoginMode === "agentmail" && mailSource !== "agentmail") {
    throw new Error(
      "PYSZNE_LOGIN_MODE=agentmail requires MAIL_SOURCE=agentmail",
    );
  }
  const rawOracleWallet =
    process.env.FULFILLMENT_ORACLE_WALLET ?? "../.demo/fulfillment-oracle.json";
  const fulfillmentOracleWallet = isAbsolute(rawOracleWallet)
    ? rawOracleWallet
    : resolve(agentRoot, rawOracleWallet);
  const options: RuntimeOptions = {
    allowPay,
    allowThreeDsSubmit,
    allowSaveCard,
    cardRail: (process.env.CARD_RAIL ?? "altitude").toLocaleLowerCase(),
    browserChannel:
      process.env.BROWSER_CHANNEL ??
      process.env.WOLT_BROWSER_CHANNEL ??
      "chrome",
    profileDir,
    glovoProfileDir,
    pyszneProfileDir,
    mailSource,
    agentMailApiKey,
    agentMailInbox,
    woltLoginMode,
    woltLoginTimeoutMs: envSeconds("WOLT_LOGIN_TIMEOUT_SECONDS", 300) * 1_000,
    pyszneLoginMode,
    pyszneLoginTimeoutMs:
      envSeconds("PYSZNE_LOGIN_TIMEOUT_SECONDS", 300) * 1_000,
    solanaRpcUrl: process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899",
    fulfillmentOracleWallet,
  };
  if (process.env.PROOF_FILE) options.proofFile = process.env.PROOF_FILE;
  if (process.env.FULFILLMENT_NONCE)
    options.nonce = process.env.FULFILLMENT_NONCE;
  return options;
}

export function renderNote(note: string, nonce?: string): string {
  if (!note.includes("{nonce}")) return note;
  if (!nonce || !/^[A-Za-z0-9_-]{1,32}$/.test(nonce)) {
    throw new Error(
      "note contains {nonce}; set FULFILLMENT_NONCE to 1–32 letters, digits, underscores, or dashes",
    );
  }
  return note.replaceAll("{nonce}", nonce);
}

export function configHash(config: AgentConfig, note: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ ...config, note }))
    .digest("hex");
}

export function specHash(config: AgentConfig): string {
  const designFile = config.spec?.design_file;
  if (designFile) {
    const path = isAbsolute(designFile)
      ? designFile
      : resolve(agentRoot, designFile);
    if (!existsSync(path))
      throw new Error(`design_file does not exist: ${path}`);
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return createHash("sha256")
    .update(JSON.stringify(config.spec ?? { items: config.items }))
    .digest("hex");
}

export function resolveDesignFile(config: AgentConfig): string | null {
  if (!config.spec?.design_file) return null;
  return isAbsolute(config.spec.design_file)
    ? config.spec.design_file
    : resolve(agentRoot, config.spec.design_file);
}

export function citySlug(city: string): string {
  return city
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function parseCardSecrets(
  vars: Record<string, string | undefined>,
  options: RuntimeOptions,
): CardSecrets {
  if (options.cardRail !== "altitude")
    throw new Error("CARD_RAIL must be altitude for automated payment");
  const pan = (vars.CARD_PAN ?? "").replace(/[\s-]/g, "");
  const exp = (vars.CARD_EXP ?? "").trim();
  const cvc = (vars.CARD_CVC ?? "").trim();
  const name = (vars.CARD_NAME ?? "").trim();
  const billingAddressLine = (vars.CARD_BILLING_ADDRESS_LINE ?? "").trim();
  const billingCity = (vars.CARD_BILLING_CITY ?? "").trim();
  const billingRegion = (vars.CARD_BILLING_REGION ?? "").trim();
  const billingPostalCode = (vars.CARD_BILLING_POSTAL_CODE ?? "").trim();
  const billingCountry = (vars.CARD_BILLING_COUNTRY ?? "")
    .trim()
    .toLocaleUpperCase();
  if (!/^\d{12,19}$/.test(pan))
    throw new Error("CARD_PAN is missing or invalid");
  if (!/^(0[1-9]|1[0-2])\/?\d{2}$/.test(exp))
    throw new Error("CARD_EXP must use MM/YY");
  if (!/^\d{3,4}$/.test(cvc)) throw new Error("CARD_CVC is missing or invalid");
  if (name.length < 2) throw new Error("CARD_NAME is missing or invalid");
  if (billingAddressLine.length < 3)
    throw new Error("CARD_BILLING_ADDRESS_LINE is missing or invalid");
  if (billingCity.toLocaleLowerCase("pl-PL") !== "kraków")
    throw new Error("CARD_BILLING_CITY must be Kraków for this PoC");
  const normalizedBillingRegion = billingRegion
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase();
  if (
    normalizedBillingRegion !== "lesser poland voivodeship" &&
    normalizedBillingRegion !== "malopolskie"
  )
    throw new Error(
      "CARD_BILLING_REGION must be Lesser Poland Voivodeship or malopolskie",
    );
  if (!/^\d{2}-\d{3}$/.test(billingPostalCode))
    throw new Error("CARD_BILLING_POSTAL_CODE must use NN-NNN");
  if (billingCountry !== "PL")
    throw new Error("CARD_BILLING_COUNTRY must be PL for this PoC");
  return {
    pan,
    exp,
    cvc,
    name,
    last4: pan.slice(-4),
    billingAddressLine,
    billingCity: "Kraków",
    billingRegion,
    billingPostalCode,
    billingCountry: "PL",
  };
}

export function loadCardSecrets(options: RuntimeOptions): CardSecrets {
  if (!options.allowPay)
    throw new Error("card secrets cannot be loaded while ALLOW_PAY=false");
  if (options.cardRail === "revolut") {
    throw new Error(
      "Revolut is a human-present fallback only. Approve 3DS in the Revolut app; automated card submission is disabled.",
    );
  }
  const fileVars = readFulfillmentCardFile();
  if (fileVars) return parseCardSecrets(fileVars, options);
  return parseCardSecrets(process.env, options);
}
