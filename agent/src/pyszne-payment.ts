import { pathToFileURL } from "node:url";
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright-core";
import {
  assertNoSaveCardPrompt,
  handleThreeDs,
  inspectPaidPage,
  verifyConfirmation,
} from "./browser.js";
import {
  buildPaymentAttemptArtifact,
  buildPaymentAuthArtifact,
  buildPurchaseArtifact,
  ensureApprovedQuoteOnChain,
  recordPaymentAttemptOnChain,
  recordPaymentAuthOnChain,
  recordPurchaseOnChain,
} from "./chain.js";
import {
  loadCardSecrets,
  loadConfig,
  loadRuntimeOptions,
  renderNote,
} from "./config.js";
import { ensureOutputDirectories, readJson, screenshotPath } from "./files.js";
import {
  assertAmountWithinCap,
  assertSecretPathsIgnored,
  beginSingleCardAttempt,
  finishSingleCardAttempt,
  redactSensitive,
} from "./policy.js";
import { requireExactConfirmation } from "./prompts.js";
import {
  hostMatches,
  isAllowedPysznePaymentUrl,
  PYSZNE_HOST,
} from "./pyszne-payment-policy.js";
import { parseCheckoutTotal } from "./quote.js";
import type {
  CardSecrets,
  PaidOutput,
  QuoteOutput,
  ThreeDsAudit,
} from "./types.js";

const CARD_FIELD_TIMEOUT_MS = 30_000;

async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function visibleFirst(locators: Locator[]): Promise<Locator | null> {
  for (const locator of locators) {
    if (await isVisible(locator)) return locator.first();
  }
  return null;
}

interface LocatedField {
  page: Page;
  frame: Frame;
  locator: Locator;
}

async function locateAcrossPages(
  context: BrowserContext,
  candidates: ((frame: Frame) => Locator)[],
  timeoutMs: number,
): Promise<LocatedField | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of context
      .pages()
      .filter((candidate) => !candidate.isClosed())) {
      for (const frame of page.frames()) {
        for (const candidate of candidates) {
          const locator = candidate(frame);
          if (await isVisible(locator)) {
            if (!isAllowedPysznePaymentUrl(frame.url())) {
              throw new Error(
                `card field appeared on unapproved payment host ${JSON.stringify(frame.url())}`,
              );
            }
            return { page, frame, locator: locator.first() };
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function requiredField(
  context: BrowserContext,
  candidates: ((frame: Frame) => Locator)[],
  value: string,
  label: string,
): Promise<LocatedField> {
  const field = await locateAcrossPages(
    context,
    candidates,
    CARD_FIELD_TIMEOUT_MS,
  );
  if (!field) throw new Error(`could not safely locate ${label} on PayU`);
  await field.locator.fill(value);
  return field;
}

async function optionalField(
  context: BrowserContext,
  candidates: ((frame: Frame) => Locator)[],
  value: string,
): Promise<void> {
  const field = await locateAcrossPages(context, candidates, 1_000);
  if (field) await field.locator.fill(value);
}

async function assertNoSaveCardAcrossPages(
  context: BrowserContext,
): Promise<void> {
  for (const page of context
    .pages()
    .filter((candidate) => !candidate.isClosed())) {
    await assertNoSaveCardPrompt(page);
  }
}

async function selectCardPayment(page: Page): Promise<void> {
  if (!/credit or debit card/i.test(await page.locator("body").innerText())) {
    const selector = await visibleFirst([
      page.getByRole("button", { name: /select payment method/i }),
      page.getByText(/select payment method/i),
    ]);
    if (!selector)
      throw new Error("Pyszne payment-method selector was missing");
    await selector.click();
    await page.waitForTimeout(300);
  }
  const card = await visibleFirst([
    page.getByRole("radio", { name: /credit or debit card/i }),
    page.getByText(/credit or debit card/i),
  ]);
  if (card) await card.click();
  const done = await visibleFirst([
    page.getByRole("button", { name: /^done$/i }),
    page.getByRole("button", { name: /confirm|continue/i }),
  ]);
  if (done) await done.click();
  await page.waitForTimeout(500);
  if (!/credit or debit card/i.test(await page.locator("body").innerText())) {
    throw new Error("Pyszne did not retain the credit/debit-card selection");
  }
}

async function fillPayuCard(
  context: BrowserContext,
  card: CardSecrets,
): Promise<Page> {
  const number = await requiredField(
    context,
    [
      (frame) => frame.getByLabel(/card number|numer karty/i),
      (frame) => frame.getByPlaceholder(/card number|numer karty/i),
      (frame) =>
        frame.locator(
          'input[autocomplete="cc-number"], input[name*="cardnumber" i], input[name*="card_number" i]',
        ),
    ],
    card.pan,
    "card number",
  );
  await requiredField(
    context,
    [
      (frame) => frame.getByLabel(/expir|mm.*yy|data ważności/i),
      (frame) => frame.getByPlaceholder(/mm.*yy|expir/i),
      (frame) =>
        frame.locator(
          'input[autocomplete="cc-exp"], input[name*="exp" i], input[name*="valid" i]',
        ),
    ],
    card.exp,
    "card expiry",
  );
  await requiredField(
    context,
    [
      (frame) => frame.getByLabel(/cvc|cvv|security code|kod bezpieczeństwa/i),
      (frame) => frame.getByPlaceholder(/cvc|cvv/i),
      (frame) =>
        frame.locator(
          'input[autocomplete="cc-csc"], input[name*="cvc" i], input[name*="cvv" i]',
        ),
    ],
    card.cvc,
    "card CVC",
  );
  await optionalField(
    context,
    [
      (frame) => frame.getByLabel(/name on card|cardholder|imię.*karcie/i),
      (frame) => frame.getByPlaceholder(/name on card|cardholder/i),
      (frame) => frame.locator('input[autocomplete="cc-name"]'),
    ],
    card.name,
  );
  await optionalField(
    context,
    [
      (frame) => frame.getByLabel(/billing address|street address/i),
      (frame) => frame.locator('input[autocomplete="address-line1"]'),
    ],
    card.billingAddressLine,
  );
  await optionalField(
    context,
    [
      (frame) => frame.getByLabel(/billing city|city|town/i),
      (frame) => frame.locator('input[autocomplete="address-level2"]'),
    ],
    card.billingCity,
  );
  await optionalField(
    context,
    [
      (frame) => frame.getByLabel(/postal|post code|zip/i),
      (frame) => frame.locator('input[autocomplete="postal-code"]'),
    ],
    card.billingPostalCode,
  );
  return number.page;
}

async function findPayButton(page: Page): Promise<LocatedField> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const candidates = [
        frame.getByRole("button", {
          name: /^(?:pay|zapłać|submit payment|confirm payment)(?:\s+.*)?$/i,
        }),
        frame.locator('button[type="submit"]'),
      ];
      for (const candidate of candidates) {
        if (await isVisible(candidate)) {
          if (!isAllowedPysznePaymentUrl(frame.url())) {
            throw new Error(
              `Pay button appeared on unapproved host ${JSON.stringify(frame.url())}`,
            );
          }
          return { page, frame, locator: candidate.first() };
        }
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error("could not safely locate the PayU Pay button");
}

export interface CheckoutFlowHooks {
  /** After the card details are filled and confirmed — before Pay is clicked. */
  onAttemptStarted?: () => void;
  /** Right after the Pay button click. */
  onPaymentSubmitted?: () => void;
  /** When a 3DS OTP challenge surface is detected. */
  onWaitingFor3ds?: () => void;
}

export interface CheckoutFlowResult {
  paid: PaidOutput;
  threeDs: ThreeDsAudit;
}

/**
 * Run the supervised Pyszne checkout for an already-gated quote and card.
 * Reused by the order executor; hooks let the caller mirror milestones into
 * the order state machine. Card secrets never leave this process.
 */
export async function runPyszneCheckoutFlow(deps: {
  config: Awaited<ReturnType<typeof loadConfig>>;
  options: Awaited<ReturnType<typeof loadRuntimeOptions>>;
  quote: QuoteOutput;
  card: CardSecrets;
  hooks?: CheckoutFlowHooks;
}): Promise<CheckoutFlowResult> {
  const { config, options, quote, card, hooks } = deps;
  if (quote.source_url === null || quote.landed_pln === null) {
    throw new Error("quote is not a payable checkout quote");
  }
  const context = await chromium.launchPersistentContext(
    options.pyszneProfileDir,
    {
      channel: options.browserChannel,
      headless: false,
      viewport: null,
      args: ["--disable-blink-features=AutomationControlled"],
    },
  );
  let attemptStarted = false;
  try {
    let page = context.pages()[0] ?? (await context.newPage());
    await page.goto(quote.source_url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);
    if (!hostMatches(new URL(page.url()).hostname, PYSZNE_HOST)) {
      throw new Error("Pyszne checkout redirected before preflight validation");
    }
    const total = parseCheckoutTotal(await page.locator("body").innerText());
    if (Math.abs(total - quote.landed_pln) > 0.01) {
      throw new Error(
        `Pyszne total changed from ${quote.landed_pln.toFixed(2)} to ${total.toFixed(2)} PLN`,
      );
    }
    await selectCardPayment(page);
    await assertNoSaveCardAcrossPages(context);
    const totalAfterPaymentSelection = parseCheckoutTotal(
      await page.locator("body").innerText(),
    );
    if (Math.abs(totalAfterPaymentSelection - quote.landed_pln) > 0.01) {
      throw new Error(
        `Pyszne total changed after payment selection from ${quote.landed_pln.toFixed(2)} to ${totalAfterPaymentSelection.toFixed(2)} PLN`,
      );
    }
    await requireExactConfirmation(
      [
        "SENSITIVE PAYMENT DATA",
        `Pyszne / PayU will receive the Altitude Visa ending ${card.last4}.`,
        `Verified total: ${quote.landed_pln.toFixed(2)} PLN.`,
        "PAN, expiry, CVC, and billing data stay inside this local process.",
      ].join("\n"),
      `ENTER CARD ${card.last4}`,
    );

    ensureApprovedQuoteOnChain(options);
    beginSingleCardAttempt(card.last4, quote.landed_pln);
    attemptStarted = true;
    const attempt = buildPaymentAttemptArtifact(quote, card.last4);
    const attemptResult = recordPaymentAttemptOnChain(options, attempt);
    console.log(
      `Payment attempt committed on-chain: ${String(attemptResult.signature)}.`,
    );
    hooks?.onAttemptStarted?.();
    const orderAndPay = await visibleFirst([
      page.getByRole("button", { name: /order.*pay|zamów.*zapłać/i }),
      page.getByText(/order.*pay|zamów.*zapłać/i),
    ]);
    if (!orderAndPay)
      throw new Error("Pyszne Order and pay button was missing");
    await orderAndPay.click();
    await page.waitForTimeout(1_500);

    page = await fillPayuCard(context, card);
    await assertNoSaveCardAcrossPages(context);
    await page.screenshot({
      path: screenshotPath("card-ready.png"),
      fullPage: true,
    });
    await requireExactConfirmation(
      [
        "FINAL FINANCIAL ACTION",
        "Merchant: Pyszne / Sklep Blumiś Ciesielskiego",
        `Amount: ${quote.landed_pln.toFixed(2)} PLN`,
        `Altitude virtual Visa: **** ${card.last4}`,
        "The next click may charge the card exactly once.",
      ].join("\n"),
      `PAY ${quote.landed_pln.toFixed(2)} ${card.last4}`,
    );
    const pay = await findPayButton(page);
    await pay.locator.click();
    await pay.page.waitForTimeout(1_500);
    hooks?.onPaymentSubmitted?.();
    const authenticationPage =
      context
        .pages()
        .filter((candidate) => !candidate.isClosed())
        .at(-1) ?? pay.page;
    const threeDs = await handleThreeDs(
      authenticationPage,
      config,
      options,
      config.merchant_descriptor ?? "PYSZNEPL",
      hooks?.onWaitingFor3ds,
    );
    const confirmationPage =
      context
        .pages()
        .filter((candidate) => !candidate.isClosed())
        .at(-1) ?? authenticationPage;
    const paid = await inspectPaidPage(confirmationPage, quote.landed_pln);
    if (!paid) {
      throw new Error(
        "Pyszne payment was submitted but order confirmation could not be verified; do not retry",
      );
    }
    const auth = buildPaymentAuthArtifact(quote, threeDs);
    const authResult = recordPaymentAuthOnChain(options, auth);
    console.log(
      `Payment authentication committed on-chain: ${String(authResult.signature)}.`,
    );
    const purchase = buildPurchaseArtifact(quote, paid, threeDs.merchant);
    const purchaseResult = recordPurchaseOnChain(options, purchase);
    console.log(
      `Merchant confirmation committed on-chain: ${String(purchaseResult.signature)}.`,
    );
    finishSingleCardAttempt("success", `order ${paid.order_id}`);
    attemptStarted = false;
    console.log(`Pyszne order ${paid.order_id} confirmed.`);
    return { paid, threeDs };
  } catch (error) {
    if (attemptStarted) {
      finishSingleCardAttempt("hard_fail", (error as Error).message);
    }
    throw error;
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  ensureOutputDirectories();
  assertSecretPathsIgnored();
  const config = loadConfig();
  const options = loadRuntimeOptions();
  const note = renderNote(config.note, options.nonce);
  if (config.adapter !== "pyszne" || config.job_kind !== "food") {
    throw new Error("payment:pyszne requires the Pyszne food adapter");
  }
  if (!options.allowPay || !options.allowThreeDsSubmit) {
    throw new Error(
      "payment:pyszne requires ALLOW_PAY=true and ALLOW_3DS_SUBMIT=true for this one run",
    );
  }
  verifyConfirmation(config, options, note);
  const quote = readJson<QuoteOutput>("quote.json");
  if (
    quote.adapter !== "pyszne" ||
    quote.landed_pln === null ||
    quote.source_url === null
  ) {
    throw new Error("quote.json is not a payable Pyszne checkout quote");
  }
  assertAmountWithinCap(quote.landed_pln, config.max_pln);
  const quoteAge = Date.now() - new Date(quote.captured_at).valueOf();
  if (!Number.isFinite(quoteAge) || quoteAge < 0 || quoteAge > 10 * 60_000) {
    throw new Error("Pyszne payment quote is older than 10 minutes");
  }
  const source = new URL(quote.source_url);
  if (
    source.protocol !== "https:" ||
    !hostMatches(source.hostname.toLocaleLowerCase(), PYSZNE_HOST) ||
    !/checkout/i.test(source.pathname)
  ) {
    throw new Error("quote source is not an HTTPS Pyszne checkout URL");
  }
  const card = loadCardSecrets(options);
  await runPyszneCheckoutFlow({ config, options, quote, card });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    const safe = redactSensitive(String((error as Error).message), [
      process.env.CARD_PAN ?? "",
      process.env.CARD_CVC ?? "",
    ]);
    console.error(`PYSZNE PAYMENT HARD FAIL: ${safe}`);
    process.exitCode = 1;
  });
}
