import { existsSync, writeFileSync } from "node:fs";
import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import { resolveDesignFile } from "../config.js";
import { verifyConfirmation } from "../browser.js";
import { outputPath, screenshotPath, writeJson } from "../files.js";
import { assertAmountWithinCap } from "../policy.js";
import { requireExactConfirmation } from "../prompts.js";
import { buildQuote, parseCheckoutTotal } from "../quote.js";
import type { AgentConfig, QuoteOutput, RuntimeOptions } from "../types.js";
import { renderManualCall } from "./manual.js";
import type { FulfillmentAdapter } from "./types.js";

const SEARCH_QUERIES = [
  "nadruk koszulek Kraków na już",
  "drukarnia Kraków ekspres",
  "naklejki Kraków",
];
const BLOCKED_HOSTS =
  /(?:aliexpress|alibaba|temu|printful|printify|amazon|facebook|instagram|youtube|tiktok)\./i;
const MERCH_SIGNALS = /nadruk|drukarni|koszulk|naklejk|tote|torb|dtf|sitodruk/i;
const KRAKOW_SIGNAL = /krak[oó]w/i;
const SAME_DAY_SIGNAL =
  /na już|od ręki|ekspres|same.day|dzisiaj|24h|odbiór.*dziś/i;

async function isVisible(locator: Locator): Promise<boolean> {
  try {
    return await locator.first().isVisible();
  } catch {
    return false;
  }
}

async function fillIfVisible(
  locator: Locator,
  value: string,
): Promise<boolean> {
  if (!(await isVisible(locator))) return false;
  await locator.first().fill(value);
  return true;
}

function safeCandidateUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (BLOCKED_HOSTS.test(url.hostname) || /google\./i.test(url.hostname))
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

function extractPhone(text: string): string | null {
  const match = text.match(/(?:\+48[\s-]?)?(?:\d[\s-]?){9}/);
  return match?.[0]?.trim() ?? null;
}

export class LocalPrintAdapter implements FulfillmentAdapter {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private sourceUrl: string | null = null;
  private shopPhone: string | null = null;
  private manual = false;
  private hasOrderForm = false;
  private quoteOutput: QuoteOutput | null = null;

  constructor(
    private readonly config: AgentConfig,
    private readonly options: RuntimeOptions,
    private readonly note: string,
  ) {
    if (config.adapter !== "local_print" || !config.spec) {
      throw new Error("LocalPrintAdapter requires a local_print merch config");
    }
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("local_print browser has not been opened");
    return this.page;
  }

  private writeManualHandoff(): void {
    writeFileSync(
      outputPath("manual_call.md"),
      `${renderManualCall(this.config, this.note, this.sourceUrl, this.shopPhone)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async searchOrOpen(): Promise<void> {
    verifyConfirmation(this.config, this.options, this.note);
    this.context = await chromium.launchPersistentContext(
      this.options.profileDir,
      {
        channel: this.options.browserChannel,
        headless: false,
        viewport: null,
        args: ["--disable-blink-features=AutomationControlled"],
      },
    );
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    const page = this.page;

    for (const query of SEARCH_QUERIES) {
      await page.goto(
        `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        {
          waitUntil: "domcontentloaded",
        },
      );
      const hrefs = await page
        .locator('a[href^="http"]')
        .evaluateAll((links) =>
          links.map((link) => (link as HTMLAnchorElement).href),
        );
      const candidates = [
        ...new Set(
          hrefs
            .map(safeCandidateUrl)
            .filter((url): url is string => Boolean(url)),
        ),
      ];
      for (const candidate of candidates.slice(0, 5)) {
        try {
          await page.goto(candidate, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          const text = (await page.locator("body").innerText()).slice(
            0,
            100_000,
          );
          if (!MERCH_SIGNALS.test(text) || !KRAKOW_SIGNAL.test(text)) continue;
          this.sourceUrl = page.url();
          this.shopPhone = extractPhone(text);
          if (!SAME_DAY_SIGNAL.test(text)) {
            this.manual = true;
            this.writeManualHandoff();
            await page.screenshot({
              path: screenshotPath("paywall.png"),
              fullPage: true,
            });
          }
          return;
        } catch {
          // A down result is skipped; no state-changing action has occurred.
        }
      }
    }
    this.manual = true;
    this.writeManualHandoff();
    await page.screenshot({
      path: screenshotPath("paywall.png"),
      fullPage: true,
    });
  }

  async buildCartOrOrderForm(): Promise<void> {
    if (this.manual) return;
    const page = this.requirePage();
    const forms = page.locator("form").filter({
      has: page.locator(
        'textarea, input[type="file"], input[name*="order" i], input[name*="message" i]',
      ),
    });
    this.hasOrderForm = (await forms.count()) > 0;
    const body = await page.locator("body").innerText();
    const phoneOnly =
      /zadzwoń|telefonicznie|whatsapp/i.test(body) && !this.hasOrderForm;
    if (!this.hasOrderForm || phoneOnly) {
      this.manual = true;
      this.writeManualHandoff();
      await page.screenshot({
        path: screenshotPath("paywall.png"),
        fullPage: true,
      });
    }
  }

  async fillDestination(): Promise<void> {
    if (this.manual || !this.hasOrderForm) return;
    const page = this.requirePage();
    await requireExactConfirmation(
      [
        "The agent is ready to place the configured demo venue address, recipient name, contact email, and optional masked phone into the local print-shop form.",
        "The form will not be submitted.",
      ].join("\n"),
      "SEND MERCH SPEC",
    );
    await fillIfVisible(
      page.getByLabel(/name|imię|nazwisko/i),
      this.config.recipient_name,
    );
    await fillIfVisible(
      page.getByLabel(/e-mail|email/i),
      this.config.contact_email,
    );
    if (this.config.phone) {
      await fillIfVisible(page.getByLabel(/phone|telefon/i), this.config.phone);
    }
    await fillIfVisible(
      page.getByLabel(/address|adres/i),
      this.config.address_line,
    );
    await page.screenshot({
      path: screenshotPath("address.png"),
      fullPage: true,
    });
  }

  async attachNote(): Promise<void> {
    if (this.manual || !this.hasOrderForm) return;
    const page = this.requirePage();
    const spec = this.config.spec!;
    const message = [
      `${spec.qty} × ${spec.item}`,
      `Text fallback: ${spec.text_fallback}`,
      `Same-day pickup preferred; otherwise courier to ${this.config.venue_label}, Kraków.`,
      `Exact note: ${this.note}`,
      `Please quote the full landed PLN amount before production.`,
    ].join("\n");
    const messageFilled = await fillIfVisible(
      page.getByLabel(/message|wiadomość|details|szczegóły|uwagi|note|opis/i),
      message,
    );
    if (!messageFilled) {
      const textarea = page.locator("textarea:visible");
      if ((await textarea.count()) > 0) await textarea.first().fill(message);
    }
    const designPath = resolveDesignFile(this.config);
    if (designPath) {
      if (!existsSync(designPath))
        throw new Error(`design_file does not exist: ${designPath}`);
      const upload = page.locator('input[type="file"]');
      if ((await upload.count()) > 0)
        await upload.first().setInputFiles(designPath);
    }
    await page.screenshot({ path: screenshotPath("cart.png"), fullPage: true });
  }

  async quote(): Promise<QuoteOutput> {
    let landedPln: number | null = null;
    let sla: "same-day" | "manual" = "manual";
    if (!this.manual) {
      const page = this.requirePage();
      const text = await page.locator("body").innerText();
      try {
        landedPln = parseCheckoutTotal(text);
        assertAmountWithinCap(landedPln, this.config.max_pln);
        sla = SAME_DAY_SIGNAL.test(text) ? "same-day" : "manual";
      } catch (error) {
        if ((error as Error).message.includes("exceeds max_pln")) throw error;
        landedPln = null;
      }
    }
    this.quoteOutput = buildQuote(
      this.config,
      this.note,
      landedPln,
      this.sourceUrl,
      sla,
    );
    writeJson("quote.json", this.quoteOutput);
    return this.quoteOutput;
  }

  async stopAtPaywall(): Promise<void> {
    if (this.manual) {
      console.log("MANUAL LOCAL-PRINT HANDOFF READY");
      console.log(
        "See agent/out/manual_call.md. No phone/WhatsApp link was clicked.",
      );
      return;
    }
    const page = this.requirePage();
    await page.screenshot({
      path: screenshotPath("paywall.png"),
      fullPage: true,
    });
    console.log("HUMAN PAY NOW");
    console.log(
      "The local-print form remains unsubmitted. The agent did not click Submit, Order, or Pay.",
    );
    if (this.options.allowPay) {
      console.log(
        "Automatic payment is unavailable for this unverified merchant form; complete it manually if the quote is acceptable.",
      );
    }
    await requireExactConfirmation(
      "Inspect or finish the visible local-print form, then close this supervised browser handoff",
      "CLOSE MERCH BROWSER",
    );
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}
