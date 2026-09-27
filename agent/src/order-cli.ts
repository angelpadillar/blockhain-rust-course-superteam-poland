import { existsSync } from "node:fs";
import {
  gotoManageCards,
  openCardPanel,
  parseRevealedCard,
} from "./altitude/commands.js";
import { AltitudeSession } from "./altitude/session.js";
import { loadConfig, loadRuntimeOptions, parseCardSecrets } from "./config.js";
import { outputPath, readJson, screenshotPath } from "./files.js";
import { assertSecretPathsIgnored, redactSensitive } from "./policy.js";
import {
  createOrder,
  listOrders,
  loadOrder,
  recordFunding,
  transitionOrder,
  updateOrder,
  type OrderRecord,
} from "./order/store.js";
import { writeFulfillmentCardFile } from "./order/secrets.js";
import { executePayment } from "./order/executor.js";
import type { QuoteOutput } from "./types.js";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function printOrder(order: OrderRecord): void {
  console.log(
    `${order.order_id}  ${order.status}  ${order.quoted_amount_pln.toFixed(2)}/${order.max_authorized_amount_pln.toFixed(2)} PLN  ${order.merchant}`,
  );
  if (order.purchase) {
    console.log(
      `    merchant order ${order.purchase.merchant_order_id} @ ${order.purchase.confirmed_at}`,
    );
  }
}

async function commandCreate(): Promise<void> {
  const orderId = process.argv[3];
  if (!orderId) throw new Error("usage: order create <order_id>");
  const config = loadConfig();
  const options = loadRuntimeOptions();
  const quote = readJson<QuoteOutput>("quote.json");
  if (quote.adapter !== config.adapter || quote.landed_pln === null) {
    throw new Error(
      "quote.json does not match the configured adapter or has no landed amount",
    );
  }
  const maxAuthorized = Number(argValue("--max") ?? config.max_pln);
  const order = createOrder({
    order_id: orderId,
    adapter: config.adapter,
    merchant: config.merchant_descriptor ?? config.adapter,
    quoted_amount_pln: quote.landed_pln,
    max_authorized_amount_pln: maxAuthorized,
    browser_session_id: `${options.pyszneProfileDir}#${quote.captured_at}`,
  });
  console.log(
    `order ${order.order_id} created: ${order.quoted_amount_pln.toFixed(2)} PLN quoted, ${order.max_authorized_amount_pln.toFixed(2)} PLN authorized max`,
  );
}

async function commandFund(): Promise<void> {
  const orderId = process.argv[3];
  if (!orderId) throw new Error("usage: order fund <order_id> [--amount N] [--ref TX]");
  const order = loadOrder(orderId);
  const amount = Number(argValue("--amount") ?? order.quoted_amount_pln);
  const reference = argValue("--ref");
  const funded = recordFunding(order, amount, reference);
  console.log(
    `order ${funded.order_id} FUNDED: ${amount.toFixed(2)} PLN received${reference ? ` (${reference})` : ""}, ${funded.funds_reserved_pln.toFixed(2)} PLN reserved`,
  );
}

async function commandStatus(): Promise<void> {
  const orderId = process.argv[3];
  if (orderId) {
    const order = loadOrder(orderId);
    printOrder(order);
    for (const event of order.history) {
      console.log(`    ${event.at}  ${event.status}  ${event.detail}`);
    }
    return;
  }
  for (const order of listOrders()) printOrder(order);
}

async function commandExecute(): Promise<void> {
  const orderId = process.argv[3];
  if (!orderId) throw new Error("usage: order execute <order_id>");
  const result = await executePayment(orderId);
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome === "blocked" || result.outcome === "failed") {
    process.exitCode = 1;
  }
}

async function commandReauth(): Promise<void> {
  const orderId = process.argv[3];
  if (!orderId) throw new Error("usage: order reauth <order_id>");
  const order = loadOrder(orderId);
  if (order.status !== "REQUIRES_REAUTHORIZATION") {
    throw new Error(
      `order ${orderId} is ${order.status}; reauth applies to REQUIRES_REAUTHORIZATION`,
    );
  }
  const config = loadConfig();
  const quote = readJson<QuoteOutput>("quote.json");
  if (quote.landed_pln === null) {
    throw new Error("reauth needs a freshly captured quote.json first");
  }
  const funded = order.funding;
  const updated = updateOrder(order, {
    quoted_amount_pln: quote.landed_pln,
    max_authorized_amount_pln: Math.max(quote.landed_pln, config.max_pln),
    funding:
      funded && funded.amount_pln >= quote.landed_pln
        ? funded
        : {
            amount_pln: quote.landed_pln,
            reference: funded?.reference ?? null,
            received_at: funded?.received_at ?? new Date().toISOString(),
          },
    funds_reserved_pln: quote.landed_pln,
  });
  const reauthorized = transitionOrder(
    updated,
    "FUNDED",
    `re-authorized at ${quote.landed_pln.toFixed(2)} PLN`,
  );
  console.log(
    `order ${reauthorized.order_id} re-authorized at ${reauthorized.quoted_amount_pln.toFixed(2)} PLN`,
  );
}

/**
 * One-time bootstrap: open a supervised Altitude session, reveal the named
 * card, and persist PAN/EXP/CVC to agent/secrets/altitude-fulfillment-card.env
 * (0600, gitignored). Afterwards purchases never touch the Altitude UI.
 */
async function commandProvisionCard(): Promise<void> {
  const cardName = process.argv[3];
  if (!cardName) {
    throw new Error("usage: order provision-card <card name, e.g. SOL-FULFILL-DEMO-01>");
  }
  if (existsSync(outputPath("card-attempt.json"))) {
    throw new Error("a card attempt marker exists; reconcile before provisioning");
  }
  const session = await AltitudeSession.attachSupervised();
  try {
    const page = session.page;
    await gotoManageCards(page);
    await openCardPanel(page, cardName);
    await page
      .getByRole("button", { name: "Show details", exact: true })
      .click();
    await page.waitForTimeout(2_000);
    const text = await page.locator("body").innerText();
    const revealed = parseRevealedCard(text);
    if (!revealed) {
      await page.screenshot({ path: screenshotPath("altitude-provision-error.png") });
      throw new Error(
        "could not parse PAN/expiry/CVC from the card details panel; screenshot saved to out/screenshots",
      );
    }
    const vars = {
      CARD_PAN: revealed.pan.replace(/\s/g, ""),
      CARD_EXP: revealed.exp,
      CARD_CVC: revealed.cvv,
      CARD_NAME: process.env.CARD_NAME ?? "",
      CARD_BILLING_ADDRESS_LINE:
        process.env.CARD_BILLING_ADDRESS_LINE ?? "",
      CARD_BILLING_CITY: process.env.CARD_BILLING_CITY ?? "",
      CARD_BILLING_REGION: process.env.CARD_BILLING_REGION ?? "",
      CARD_BILLING_POSTAL_CODE:
        process.env.CARD_BILLING_POSTAL_CODE ?? "",
      CARD_BILLING_COUNTRY: process.env.CARD_BILLING_COUNTRY ?? "PL",
    };
    const options = loadRuntimeOptions();
    parseCardSecrets(vars, options);
    const path = writeFulfillmentCardFile(vars);
    console.log(
      `Fulfillment card ending ${revealed.pan.slice(-4)} provisioned to ${path} (0600). No card data was printed.`,
    );
  } finally {
    await session.context.close();
  }
}

async function main(): Promise<void> {
  assertSecretPathsIgnored();
  const command = process.argv[2];
  switch (command) {
    case "create":
      await commandCreate();
      return;
    case "fund":
      await commandFund();
      return;
    case "status":
      await commandStatus();
      return;
    case "execute":
      await commandExecute();
      return;
    case "reauth":
      await commandReauth();
      return;
    case "provision-card":
      await commandProvisionCard();
      return;
    default:
      throw new Error(
        "usage: order create|fund|status|execute|reauth|provision-card",
      );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `ORDER HARD FAIL: ${redactSensitive(message, [process.env.CARD_PAN ?? "", process.env.CARD_CVC ?? ""])}`,
  );
  process.exitCode = 1;
});
