import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  addApprovedItems,
  assertNoSaveCardPrompt,
  attachDeliveryNote,
  dismissCookieConsent,
  ensureLoggedIn,
  fillCard,
  fillDeliveryDetails,
  handleThreeDs,
  humanPaymentHandoff,
  inspectPaidPage,
  openCheckout,
  verifyConfirmation,
} from "../browser.js";
import { citySlug } from "../config.js";
import {
  buildPaymentAttemptArtifact,
  buildPaymentAuthArtifact,
  buildPurchaseArtifact,
  ensureApprovedQuoteOnChain,
  recordPaymentAttemptOnChain,
  recordPaymentAuthOnChain,
  recordPurchaseOnChain,
} from "../chain.js";
import { writeFulfillment } from "../finalize.js";
import { readJson, screenshotPath, writeJson } from "../files.js";
import { assertAmountWithinCap, finishSingleCardAttempt } from "../policy.js";
import {
  buildQuote,
  parseCheckoutBreakdown,
  parseCheckoutTotal,
} from "../quote.js";
import type {
  AgentConfig,
  PaidOutput,
  QuoteOutput,
  RuntimeOptions,
} from "../types.js";
import type { FulfillmentAdapter } from "./types.js";

export class WoltAdapter implements FulfillmentAdapter {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private amountPln: number | null = null;
  private cardAttemptStarted = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly options: RuntimeOptions,
    private readonly note: string,
  ) {
    if (config.adapter !== "wolt" || config.job_kind !== "food") {
      throw new Error("WoltAdapter accepts food jobs only");
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Wolt browser has not been opened");
    return this.page;
  }

  private requireAmount(): number {
    if (this.amountPln === null)
      throw new Error("Wolt quote has not been verified");
    return this.amountPln;
  }

  private finish(paid: PaidOutput): void {
    writeJson("paid.json", paid);
    writeFulfillment(paid, this.config, this.options, this.note);
    console.log(`Order confirmed: ${paid.order_id}`);
    console.log("Resume the Solana demo with:");
    console.log(
      `LIVE_DEMO=1 PROOF_FILE=${JSON.stringify(this.options.proofFile ?? "/absolute/path/to/proof-photo.jpg")} yarn demo:surfpool`,
    );
  }

  async searchOrOpen(): Promise<void> {
    verifyConfirmation(this.config, this.options, this.note);
    try {
      this.context = await chromium.launchPersistentContext(
        this.options.profileDir,
        {
          channel: this.options.browserChannel,
          headless: false,
          viewport: null,
          args: ["--disable-blink-features=AutomationControlled"],
        },
      );
    } catch (error) {
      const message = (error as Error).message;
      if (
        /Opening in existing browser session|profile.*in use/i.test(message)
      ) {
        throw new Error(
          "agent/chrome-profile is already open in Chrome. Quit the dedicated demo Chrome window, do not run the manual `open` command again, then rerun npm run order:prepare.",
        );
      }
      throw error;
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    const city = citySlug(this.config.city);
    await this.page.goto(`https://wolt.com/en/pol/${city}`, {
      waitUntil: "domcontentloaded",
    });
    if (!this.page.url().includes(`/pol/${city}`)) {
      throw new Error(
        `destination city guard failed; Wolt URL is ${this.page.url()}`,
      );
    }
    await dismissCookieConsent(this.page);
    this.page = await ensureLoggedIn(this.page, this.config, this.options);
  }

  async buildCartOrOrderForm(): Promise<void> {
    const page = this.requirePage();
    await addApprovedItems(page, this.config);
    await openCheckout(page);
  }

  async fillDestination(): Promise<void> {
    await fillDeliveryDetails(this.requirePage(), this.config);
  }

  async attachNote(): Promise<void> {
    await attachDeliveryNote(this.requirePage(), this.note);
  }

  async quote(): Promise<QuoteOutput> {
    const page = this.requirePage();
    const checkoutText = await page.locator("body").innerText();
    this.amountPln = parseCheckoutTotal(checkoutText);
    assertAmountWithinCap(this.amountPln, this.config.max_pln);
    await assertNoSaveCardPrompt(page);
    await page.screenshot({
      path: screenshotPath("paywall.png"),
      fullPage: true,
    });
    const quote = buildQuote(
      this.config,
      this.note,
      this.amountPln,
      page.url(),
      "same-day",
    );
    quote.breakdown_pln = parseCheckoutBreakdown(checkoutText, this.amountPln);
    writeJson("quote.json", quote);
    console.log(
      `Cart verified: ${this.amountPln.toFixed(2)} PLN <= ${this.config.max_pln.toFixed(2)} PLN.`,
    );
    return quote;
  }

  async stopAtPaywall(): Promise<void> {
    if (this.options.allowPay) return;
    await humanPaymentHandoff(this.requirePage(), this.requireAmount());
  }

  async pay(): Promise<void> {
    const page = this.requirePage();
    const amount = this.requireAmount();
    const quote = readJson<QuoteOutput>("quote.json");
    try {
      const approval = ensureApprovedQuoteOnChain(this.options);
      console.log(
        `Exact on-chain quote approval verified for campaign ${String(approval.campaign)}.`,
      );
      await fillCard(page, this.options, amount, async (last4) => {
        this.cardAttemptStarted = true;
        const attempt = buildPaymentAttemptArtifact(quote, last4);
        const result = recordPaymentAttemptOnChain(this.options, attempt);
        console.log(
          `Payment attempt committed on-chain: ${String(result.signature)}.`,
        );
      });
      const threeDs = await handleThreeDs(page, this.config, this.options);
      const paid = await inspectPaidPage(page, amount);
      if (!paid) {
        console.log("Payment status could not be verified automatically.");
        console.log(
          "The on-chain campaign remains at PaymentAttempted; no authentication or purchase was claimed.",
        );
        return;
      }
      const auth = buildPaymentAuthArtifact(quote, threeDs);
      const authResult = recordPaymentAuthOnChain(this.options, auth);
      console.log(
        `Payment authentication committed on-chain: ${String(authResult.signature)}.`,
      );
      const purchase = buildPurchaseArtifact(quote, paid, threeDs.merchant);
      const purchaseResult = recordPurchaseOnChain(this.options, purchase);
      console.log(
        `Merchant order confirmation committed on-chain: ${String(purchaseResult.signature)}.`,
      );
      finishSingleCardAttempt("success", `order ${paid.order_id}`);
      this.cardAttemptStarted = false;
      this.finish(paid);
    } catch (error) {
      if (this.cardAttemptStarted) {
        finishSingleCardAttempt("hard_fail", (error as Error).message);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
