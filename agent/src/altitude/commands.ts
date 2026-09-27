import { chmodSync, writeFileSync } from "node:fs";
import { writeJson, outputPath, ensureOutputDirectories } from "../files.js";
import type { AltitudeSession, AttachMode } from "./session.js";
import type { Page } from "playwright-core";

/**
 * Card command surface exposed by the Altitude daemon.
 *
 * Card commands validate their payload against the funding policy before
 * observing or changing the Altitude dashboard. Live card operations remain
 * behind ALTITUDE_LIVE_CARD_OPS=1; the default is a dry run.
 */

export const CARD_COMMANDS = ["create", "fund", "freeze", "close"] as const;
export type CardCommand = (typeof CARD_COMMANDS)[number];

export const SETTLEMENT_CURRENCIES = ["USDC", "SOL"] as const;
export type SettlementCurrency = (typeof SETTLEMENT_CURRENCIES)[number];
export type CommandStatus = "stub" | "dry_run" | "live";

export interface CardSummary {
  cardholder: string | null;
  name: string;
  last4: string;
  status: string;
  limit: string;
}

export function resolveAttachMode(
  requested: unknown,
  credentialStored: boolean,
): AttachMode {
  if (requested === undefined || requested === null || requested === "") {
    return credentialStored ? "injected" : "supervised";
  }
  if (requested === "injected" || requested === "supervised") {
    return requested;
  }
  throw new Error('mode must be "injected" or "supervised"');
}

export interface CardCommandRequest {
  command: CardCommand;
  reference: string;
  amountUsd?: number;
  currency?: SettlementCurrency;
  cardId?: string;
  reveal?: boolean;
}

export interface CardCommandResult {
  ok: boolean;
  status: CommandStatus;
  command: CardCommand;
  request: CardCommandRequest;
  card?: {
    name: string;
    last4: string;
    status: string | null;
    limit: string | null;
    secrets_path?: string;
  };
  recon_needed?: string[];
  observed: { url: string; screenshot: string };
  at: string;
  error?: string;
  note?: string;
}

export interface BalanceResult {
  ok: boolean;
  status: CommandStatus;
  spendable_usd: number | null;
  cards: CardSummary[];
  observed: { url: string; screenshot: string };
  at: string;
  error?: string;
}

const LIMIT_FREQUENCIES = [
  "All time",
  "7 day",
  "30 day",
  "Per authorization",
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function moneyAfterLabel(text: string): number | null {
  const labels =
    /(?:Spendable balance|Cards account balance)[\s\S]*?\$([0-9,]+\.\d{2})/i;
  const match = text.match(labels);
  if (!match) return null;
  const value = Number(match[1]!.replaceAll(",", ""));
  return Number.isFinite(value) ? value : null;
}

export function parseSpendableBalance(text: string): number | null {
  return moneyAfterLabel(text);
}

export function parseCardRows(text: string): CardSummary[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const rows: CardSummary[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const mask = line.match(/••••\s*(\d{4})/);
    if (!mask) continue;
    const beforeMask = line.slice(0, mask.index ?? 0).trim();
    const cardName = beforeMask || lines[index - 1] || "";
    if (!cardName) continue;
    const cardNameIndex = beforeMask ? index : index - 1;
    const preceding = lines[cardNameIndex - 1] ?? "";
    const cardholder =
      cardNameIndex > 0 &&
      !/^(?:Spendable balance|Cards account balance|Top up|Withdraw|Issue)$/i.test(
        preceding,
      ) &&
      !/^(?:Active|Frozen|Closed|Pending|Blocked|Canceled|Cancelled)$/i.test(
        preceding,
      ) &&
      !/^\$[\d,]+(?:\.\d{2})?\s*(?:\/\s*\d+\s*days?|Per authorization|All time)$/i.test(
        preceding,
      )
        ? preceding
        : null;
    const window = lines.slice(index, index + 10).join(" ");
    const status =
      window.match(
        /\b(Active|Frozen|Closed|Pending|Blocked|Canceled|Cancelled)\b/i,
      )?.[1] ?? "";
    const limit =
      window.match(
        /\$[\d,]+(?:\.\d{2})?\s*\/?\s*(?:per\s*authorization|\d+\s*days?|all\s*time)/i,
      )?.[0] ?? "";
    rows.push({
      cardholder,
      name: cardName,
      last4: mask[1]!,
      status,
      limit,
    });
  }
  return rows;
}

export function parseLast4(text: string): string | null {
  const grouped = text.match(/(?:••••\s+){2}••••\s+(\d{4})/);
  if (grouped) return grouped[1]!;
  const matches = [...text.matchAll(/••••\s*(\d{4})/g)];
  return matches.at(-1)?.[1] ?? null;
}

export function parseRevealedCard(
  text: string,
): { pan: string; exp: string; cvv: string } | null {
  const pan = text.match(/\b(\d{4} \d{4} \d{4} \d{4})\b/);
  const expiry = text.match(/\b(0[1-9]|1[0-2])\/(\d{2})\b/);
  if (!pan || !expiry || expiry.index === undefined) return null;
  const cvv = text
    .slice(expiry.index + expiry[0].length)
    .match(/\b\d{3}\b/)?.[0];
  if (!cvv) return null;
  return { pan: pan[1]!, exp: expiry[0]!, cvv };
}

export function resolveLimitFrequency(raw: unknown): string {
  const value =
    typeof raw === "string" && raw.trim() ? raw.trim() : "Per authorization";
  if (
    !LIMIT_FREQUENCIES.includes(value as (typeof LIMIT_FREQUENCIES)[number])
  ) {
    throw new Error(
      `ALTITUDE_CARD_LIMIT_FREQUENCY must be one of ${LIMIT_FREQUENCIES.join(", ")}`,
    );
  }
  return value;
}

export function isLiveCardOps(): boolean {
  return process.env.ALTITUDE_LIVE_CARD_OPS?.trim() === "1";
}

export interface DashboardFlowOptions {
  screenshot?: (name: string) => Promise<string>;
  live?: boolean;
  cardholderEmail?: string;
}

async function screenshot(
  options: DashboardFlowOptions,
  name: string,
): Promise<string> {
  return options.screenshot ? options.screenshot(name) : "";
}

async function pageText(page: Page): Promise<string> {
  const main = page.locator("main");
  return (await main.count()) > 0
    ? main.innerText()
    : page.locator("body").innerText();
}

export async function gotoManageCards(page: Page): Promise<void> {
  const manage = page.getByRole("link", { name: "Manage cards", exact: true });
  if (!(await manage.isVisible().catch(() => false))) {
    await page.getByRole("link", { name: "Cards", exact: true }).click();
  }
  await manage.click();
  try {
    await page.getByText("Spendable balance", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch {
    throw new Error(
      "dashboard not reachable — is the supervised session logged in?",
    );
  }
}

export async function openCardPanel(page: Page, cardId: string): Promise<void> {
  await page
    .getByText(new RegExp(escapeRegExp(cardId), "i"))
    .first()
    .click();
  const panelReady = page
    .getByRole("button", { name: /^(Freeze|Unfreeze)$/ })
    .or(page.getByText("Frozen", { exact: true }))
    .first();
  await panelReady.waitFor({ state: "visible", timeout: 15_000 });
}

const RECON_BY_COMMAND: Record<CardCommand, string[]> = {
  create: [
    "selector for the create-card control and the resulting card id",
    "whether card creation re-prompts the passkey",
    "where the PAN/CVV/expiry are rendered so they can be captured without logging",
  ],
  fund: [
    "selector for the transfer/top-up form from the Squads account to the card",
    "whether funding re-prompts the passkey",
    "the settlement confirmation element that proves the balance moved",
  ],
  freeze: ["selector for the freeze toggle and its confirmed state"],
  close: ["selector for the close-card control and its confirmation dialog"],
};

function maxCardUsd(): number {
  const raw = (process.env.ALTITUDE_MAX_CARD_USD ?? "").trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      "ALTITUDE_MAX_CARD_USD must be set to a positive per-card spend cap",
    );
  }
  return parsed;
}

export function assertCardAmountWithinCap(
  amountUsd: number,
  maxUsd: number,
): void {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("card amount is missing or invalid; command is blocked");
  }
  if (amountUsd > maxUsd) {
    throw new Error(
      `HARD FAIL: card amount ${amountUsd.toFixed(2)} USD exceeds ALTITUDE_MAX_CARD_USD ${maxUsd.toFixed(2)} USD`,
    );
  }
}

export function validateCardCommand(
  body: unknown,
  maxUsd = maxCardUsd(),
): CardCommandRequest {
  if (typeof body !== "object" || body === null) {
    throw new Error("request body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;
  const command = raw.command;
  if (
    typeof command !== "string" ||
    !CARD_COMMANDS.includes(command as CardCommand)
  ) {
    throw new Error(`command must be one of ${CARD_COMMANDS.join(", ")}`);
  }
  const reference = raw.reference;
  if (typeof reference !== "string" || !/^[\w.:-]{4,64}$/.test(reference)) {
    throw new Error(
      "reference must be a 4-64 character order reference so the command is auditable",
    );
  }
  const request: CardCommandRequest = {
    command: command as CardCommand,
    reference,
  };

  if (command === "create" || command === "fund") {
    const amountUsd = Number(raw.amount_usd);
    assertCardAmountWithinCap(amountUsd, maxUsd);
    request.amountUsd = amountUsd;
    const currency = (raw.currency ?? "USDC") as SettlementCurrency;
    if (!SETTLEMENT_CURRENCIES.includes(currency)) {
      throw new Error(
        `currency must be one of ${SETTLEMENT_CURRENCIES.join(", ")}`,
      );
    }
    request.currency = currency;
  }

  if (raw.reveal !== undefined) {
    if (command !== "create" || typeof raw.reveal !== "boolean") {
      throw new Error("reveal is only supported as a boolean for create");
    }
    request.reveal = raw.reveal;
  }

  if (command !== "create") {
    const cardId = raw.card_id;
    if (typeof cardId !== "string" || cardId.length === 0) {
      throw new Error(`card_id is required for the ${command} command`);
    }
    request.cardId = cardId;
  }

  return request;
}

function cardLimit(text: string): string | null {
  return (
    text.match(
      /\$[\d,]+(?:\.\d{2})?\s*(?:\/\s*\d+\s*days?|Per authorization|All time)/i,
    )?.[0] ?? null
  );
}

function cardholderFromPanel(text: string, fallback: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const index = lines.findIndex((line) => /^Cardholder:?$/i.test(line));
  return index >= 0 && lines[index + 1] ? lines[index + 1]! : fallback;
}

function operationStatus(live: boolean): "dry_run" | "live" {
  return live ? "live" : "dry_run";
}

async function safeScreenshot(
  page: Page,
  options: DashboardFlowOptions,
  name: string,
): Promise<string> {
  try {
    return await screenshot(options, name);
  } catch {
    return "";
  }
}

export async function readBalanceFrom(
  page: Page,
  options: DashboardFlowOptions = {},
): Promise<BalanceResult> {
  const observed = { url: page.url(), screenshot: "" };
  try {
    await gotoManageCards(page);
    const text = await pageText(page);
    const spendable = parseSpendableBalance(text);
    const cards = parseCardRows(text);
    observed.screenshot = await screenshot(options, "altitude-balance.png");
    return {
      ok: spendable !== null,
      status: "live",
      spendable_usd: spendable,
      cards,
      observed,
      at: new Date().toISOString(),
    };
  } catch (error) {
    observed.screenshot = await safeScreenshot(
      page,
      options,
      "altitude-balance.png",
    );
    return {
      ok: false,
      status: "live",
      spendable_usd: null,
      cards: [],
      observed,
      at: new Date().toISOString(),
      error: (error as Error).message,
    };
  }
}

async function chooseFrequency(page: Page, frequency: string): Promise<void> {
  const control = page
    .getByText("Frequency", { exact: true })
    .locator(
      "xpath=following::*[@role='combobox' or @role='button' or self::button][1]",
    );
  await control.click();
  const option = page.getByRole("option", { name: frequency, exact: true });
  if ((await option.count()) > 0) {
    await option.last().click();
    return;
  }
  await page.getByText(frequency, { exact: true }).last().click();
}

async function selectCardholder(page: Page, email: string): Promise<void> {
  const input = page.getByPlaceholder("Member name or email to invite");
  await input.click();
  await input.fill(email);
  const option = page.getByText(email, { exact: false }).last();
  const optionText = await option.innerText();
  const memberName = optionText.replace(email, "").trim();
  await option.click();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await input.inputValue().catch(() => "");
    const parentText = await input
      .locator("xpath=..")
      .innerText()
      .catch(() => "");
    if (
      value.includes(email) ||
      parentText.includes(email) ||
      (memberName !== "" && parentText.includes(memberName))
    ) {
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error("cardholder selection did not contain the configured email");
}

function writeCardSecrets(
  reference: string,
  cardholder: string,
  revealed: { pan: string; exp: string; cvv: string },
): string {
  ensureOutputDirectories();
  const path = outputPath(`altitude-card-${reference}.env`);
  writeFileSync(
    path,
    [
      `CARD_PAN=${revealed.pan}`,
      `CARD_EXP=${revealed.exp}`,
      `CARD_CVC=${revealed.cvv}`,
      `CARD_NAME=${cardholder}`,
      `ALTITUDE_CARD_LAST4=${revealed.pan.slice(-4)}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

export async function createCardOn(
  page: Page,
  request: CardCommandRequest,
  options: DashboardFlowOptions = {},
): Promise<CardCommandResult> {
  const live = options.live ?? isLiveCardOps();
  const status = operationStatus(live);
  const observed = { url: page.url(), screenshot: "" };
  try {
    const amountUsd = request.amountUsd;
    if (amountUsd === undefined) {
      throw new Error("card amount is missing or invalid; command is blocked");
    }
    const frequency = resolveLimitFrequency(
      process.env.ALTITUDE_CARD_LIMIT_FREQUENCY,
    );
    const email = (
      options.cardholderEmail ??
      process.env.ALTITUDE_CARDHOLDER_EMAIL ??
      ""
    ).trim();
    if (!email) {
      throw new Error("ALTITUDE_CARDHOLDER_EMAIL must be set for card create");
    }
    await gotoManageCards(page);
    const existing = parseCardRows(await pageText(page)).find(
      (card) => card.name === request.reference,
    );
    if (existing) {
      return {
        ok: false,
        status,
        command: "create",
        request,
        card: {
          name: existing.name,
          last4: existing.last4,
          status: existing.status || null,
          limit: existing.limit || null,
        },
        observed,
        at: new Date().toISOString(),
        error: "card with this reference already exists",
      };
    }
    await page.getByRole("button", { name: "Issue", exact: true }).click();
    await page.getByText("Issue a new virtual card", { exact: true }).waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await page
      .getByPlaceholder("What will this card be used for?")
      .fill(request.reference);
    await selectCardholder(page, email);
    await page.getByPlaceholder("0.00").fill(amountUsd.toFixed(2));
    await chooseFrequency(page, frequency);
    observed.screenshot = await screenshot(
      options,
      "altitude-card-create-form.png",
    );
    if (!live) {
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      return {
        ok: true,
        status,
        command: "create",
        request,
        card: {
          name: request.reference,
          last4: "",
          status: null,
          limit: `${amountUsd.toFixed(2)} ${frequency}`,
        },
        observed,
        at: new Date().toISOString(),
        note: "form filled and cancelled; set ALTITUDE_LIVE_CARD_OPS=1 to issue",
      };
    }
    await page.getByRole("button", { name: "Issue card", exact: true }).click();
    const heading = page.getByRole("heading", {
      name: new RegExp(escapeRegExp(request.reference), "i"),
    });
    await heading.waitFor({ state: "visible", timeout: 30_000 });
    await page
      .getByRole("button", { name: "Freeze", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    const panelText = await pageText(page);
    const card: NonNullable<CardCommandResult["card"]> = {
      name: request.reference,
      last4: parseLast4(panelText) ?? "",
      status: /\bActive\b/i.test(panelText) ? "Active" : null,
      limit: cardLimit(panelText),
    };
    observed.screenshot = await screenshot(options, "altitude-card-create.png");
    if (request.reveal) {
      await page
        .getByRole("button", { name: "Show details", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Hide details", exact: true })
        .waitFor({ state: "visible", timeout: 15_000 });
      const details = await pageText(page);
      const revealed = parseRevealedCard(details);
      if (!revealed) {
        throw new Error("could not parse revealed card details");
      }
      const secretsPath = writeCardSecrets(
        request.reference,
        cardholderFromPanel(details, request.reference),
        revealed,
      );
      card.secrets_path = secretsPath;
      await page
        .getByRole("button", { name: "Hide details", exact: true })
        .click();
    }
    return {
      ok: true,
      status,
      command: "create",
      request,
      card,
      observed,
      at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status,
      command: "create",
      request,
      observed,
      at: new Date().toISOString(),
      error: (error as Error).message,
    };
  }
}

export async function freezeCardOn(
  page: Page,
  cardId: string,
  options: DashboardFlowOptions = {},
): Promise<CardCommandResult> {
  const live = options.live ?? isLiveCardOps();
  const status = operationStatus(live);
  const request: CardCommandRequest = {
    command: "freeze",
    reference: cardId,
    cardId,
  };
  const observed = { url: page.url(), screenshot: "" };
  try {
    await gotoManageCards(page);
    const summary = parseCardRows(await pageText(page)).find(
      (card) => card.name === cardId || card.last4 === cardId,
    );
    await openCardPanel(page, cardId);
    observed.screenshot = await screenshot(options, "altitude-card-freeze.png");
    if (!live) {
      return {
        ok: true,
        status,
        command: "freeze",
        request,
        card: {
          name: summary?.name ?? cardId,
          last4: summary?.last4 ?? "",
          status: summary?.status || null,
          limit: summary?.limit || null,
        },
        observed,
        at: new Date().toISOString(),
        note: "freeze preview only; set ALTITUDE_LIVE_CARD_OPS=1 to freeze",
      };
    }
    await page.getByRole("button", { name: "Freeze", exact: true }).click();
    const dialog = page.getByRole("dialog");
    let dialogVisible = false;
    try {
      await dialog.waitFor({ state: "visible", timeout: 2_000 });
      dialogVisible = true;
    } catch {
      dialogVisible = false;
    }
    if (dialogVisible) {
      await dialog.getByRole("button", { name: /freeze|confirm/i }).click();
    }
    const frozen = page
      .getByRole("button", { name: "Unfreeze", exact: true })
      .or(page.getByText("Frozen", { exact: true }))
      .first();
    await frozen.waitFor({ state: "visible", timeout: 15_000 });
    const panelText = await pageText(page);
    return {
      ok: true,
      status,
      command: "freeze",
      request,
      card: {
        name: summary?.name ?? cardId,
        last4: summary?.last4 ?? parseLast4(panelText) ?? "",
        status: /\bFrozen\b/i.test(panelText) ? "Frozen" : null,
        limit: summary?.limit ?? cardLimit(panelText),
      },
      observed,
      at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status,
      command: "freeze",
      request,
      observed,
      at: new Date().toISOString(),
      error: (error as Error).message,
    };
  }
}

export async function runCardCommand(
  session: AltitudeSession,
  request: CardCommandRequest,
): Promise<CardCommandResult> {
  const options = { screenshot: (name: string) => session.screenshot(name) };
  let result: CardCommandResult;
  if (request.command === "create") {
    result = await createCardOn(session.page, request, options);
  } else if (request.command === "freeze") {
    result = await freezeCardOn(session.page, request.cardId!, options);
  } else {
    const screenshot = await session.screenshot(
      `altitude-card-${request.command}.png`,
    );
    result = {
      ok: false,
      status: "stub",
      command: request.command,
      request,
      recon_needed: RECON_BY_COMMAND[request.command],
      observed: { url: session.page.url(), screenshot },
      at: new Date().toISOString(),
    };
  }
  writeJson(`altitude-card-${request.command}.json`, result);
  return result;
}

export async function readBalance(
  session: AltitudeSession,
): Promise<BalanceResult> {
  const result = await readBalanceFrom(session.page, {
    screenshot: (name: string) => session.screenshot(name),
  });
  writeJson("altitude-balance.json", result);
  return result;
}
