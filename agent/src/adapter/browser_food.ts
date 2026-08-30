import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";
import {
  assertNoSaveCardPrompt,
  humanPaymentHandoff,
  verifyConfirmation,
} from "../browser.js";
import {
  listRecentPyszneMessageIds,
  pollForPyszneLoginChallenge,
} from "../agentmail.js";
import { readJson, writeJson, screenshotPath } from "../files.js";
import {
  type McpBrowserObservation,
  validateMcpBrowserObservation,
} from "../mcp-observation.js";
import { requireExactConfirmation } from "../prompts.js";
import type {
  AdapterName,
  AgentConfig,
  QuoteOutput,
  RuntimeOptions,
} from "../types.js";
import type { FulfillmentAdapter } from "./types.js";

interface BrowserFoodSite {
  adapter: Extract<AdapterName, "glovo" | "pyszne">;
  label: "Glovo" | "Pyszne.pl";
  host: string;
  startUrl: string;
  profileDir: (options: RuntimeOptions) => string;
  supportsGuestCheckout: boolean;
}

const FOOD_SIGNALS =
  /food|jedzenie|restaurant|restaurac|menu|delivery|dostaw|bakery|piekarni|cukierni|dessert|deser|ciast|sernik|grocer|market|supermarket|sklep|nabiał|nabial|dairy|mleko|milk/i;

export function parseRemainingMinimumOrder(text: string): number | null {
  const match = text.match(
    /spend another\s+(\d{1,4}(?:[.,]\d{2})?)\s*(?:zł|pln)\s+for delivery/i,
  );
  if (!match?.[1]) return null;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

interface PyszneEmailControl {
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
}

export async function submitPyszneEmailLogin(
  email: PyszneEmailControl,
  address: string,
): Promise<void> {
  await email.fill(address);
  await email.press("Enter");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function foldText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("pl-PL");
}

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

export class BrowserFoodAdapter implements FulfillmentAdapter {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private amountPln: number | null = null;
  private destinationPrepared = false;

  constructor(
    private readonly site: BrowserFoodSite,
    private readonly config: AgentConfig,
    private readonly options: RuntimeOptions,
    private readonly note: string,
  ) {
    if (config.adapter !== site.adapter || config.job_kind !== "food") {
      throw new Error(`${site.label} accepts food jobs only`);
    }
  }

  private syncPage(): Page {
    const pages =
      this.context?.pages().filter((page) => !page.isClosed()) ?? [];
    this.page = pages.at(-1) ?? this.page;
    if (!this.page || this.page.isClosed()) {
      throw new Error(`the controlled ${this.site.label} tab was closed`);
    }
    return this.page;
  }

  private async bodyText(): Promise<string> {
    return this.syncPage().locator("body").innerText();
  }

  private assertProviderPage(page: Page): void {
    const host = new URL(page.url()).hostname.toLocaleLowerCase();
    if (host !== this.site.host && !host.endsWith(`.${this.site.host}`)) {
      throw new Error(
        `merchant host guard failed; expected ${this.site.host}, received ${host}`,
      );
    }
  }

  private async dismissCookies(): Promise<void> {
    const page = this.syncPage();
    const choice = await visibleFirst([
      page.getByRole("button", {
        name: /reject|necessary only|only necessary|odrzuć|tylko niezbędne/i,
      }),
      page.getByRole("button", {
        name: /accept all|allow all|agree|akceptuj wszystkie|zgadzam się/i,
      }),
    ]);
    if (choice) await choice.click();
  }

  private async selectAddressSuggestion(): Promise<boolean> {
    const page = this.syncPage();
    const street = foldText(this.config.address_line.split(",")[0] ?? "");
    const candidates = page.locator(
      '[role="option"], [data-qa*="suggest" i], [data-testid*="suggest" i]',
    );
    const count = await candidates.count();
    for (let index = 0; index < Math.min(count, 12); index += 1) {
      const candidate = candidates.nth(index);
      if (!(await isVisible(candidate))) continue;
      const text = foldText(await candidate.innerText());
      if (text.includes(street) && text.includes("krakow")) {
        await candidate.click();
        return true;
      }
    }
    return false;
  }

  private async ensureDestinationForBrowsing(): Promise<void> {
    const page = this.syncPage();
    const street = foldText(this.config.address_line.split(",")[0] ?? "");
    if (foldText(await this.bodyText()).includes(street)) {
      this.destinationPrepared = true;
      return;
    }

    const address = await visibleFirst([
      page.getByPlaceholder(
        /full address|enter.*address|delivery address|wpisz adres|adres dostawy/i,
      ),
      page.getByLabel(
        /full address|enter.*address|delivery address|wpisz adres|adres dostawy/i,
      ),
      page.locator('input[autocomplete="street-address"]'),
    ]);
    if (address) {
      await address.fill(this.config.address_line);
      await page.waitForTimeout(1_000);
      if (!(await this.selectAddressSuggestion())) {
        const search = await visibleFirst([
          page.getByRole("button", { name: /^search$|^szukaj$/i }),
          page.getByRole("button", {
            name: /use this address|continue|dalej/i,
          }),
        ]);
        if (search) await search.click();
        else await address.press("Enter");
      }
      await page.waitForTimeout(1_500);
    }

    if (!address || !foldText(await this.bodyText()).includes(street)) {
      await requireExactConfirmation(
        `In the visible ${this.site.label} window, set delivery to ${JSON.stringify(this.config.address_line)} and select the Kraków suggestion. Do not use a different address.`,
        `${this.site.adapter.toLocaleUpperCase()} ADDRESS READY`,
      );
    }
    this.assertProviderPage(this.syncPage());
    const text = foldText(await this.bodyText());
    const cityConfirmed =
      text.includes("krakow") || /krakow/i.test(this.syncPage().url());
    if (!cityConfirmed) {
      throw new Error(
        `${this.site.label} does not visibly confirm destination city Kraków`,
      );
    }
    this.destinationPrepared = true;
  }

  private async tryAutomaticSingleItem(): Promise<void> {
    const page = this.syncPage();
    if (this.config.items.length !== 1 || this.config.items[0]?.qty !== 1) {
      throw new Error("automatic food search supports one item with qty=1");
    }
    const item = this.config.items[0];
    if (!item) throw new Error("approved item is missing");
    const search = await visibleFirst([
      page.getByRole("searchbox"),
      page.getByRole("textbox", { name: /search|szukaj/i }),
      page.locator(
        'search input, input[placeholder*="search" i], input[placeholder*="szukaj" i]',
      ),
      page.getByPlaceholder(
        /what can we get you|what.*looking for|search|czego szukasz|szukaj/i,
      ),
      page.locator('input[type="search"]'),
    ]);
    if (!search) throw new Error("food search input was not found");
    await search.fill(item.query);
    await search.press("Enter");
    await page.waitForTimeout(1_500);

    const query = new RegExp(escapeRegExp(item.query), "i");
    const result = await visibleFirst([
      page.getByRole("link", { name: query }),
      page.getByText(query),
    ]);
    if (!result) {
      throw new Error(
        `no visible food result matched ${JSON.stringify(item.query)}`,
      );
    }
    await result.click();
    await page.waitForTimeout(1_000);
    this.assertProviderPage(this.syncPage());
    if (!FOOD_SIGNALS.test(`${item.query}\n${await this.bodyText()}`)) {
      throw new Error("result could not be verified as food delivery");
    }
    const add = await visibleFirst([
      page.getByRole("button", { name: /add to (?:order|cart)|^add$|dodaj/i }),
      page.getByText(/add to (?:order|cart)|dodaj do/i),
    ]);
    if (!add) throw new Error("approved food item had no visible Add control");
    await add.click();
  }

  private async openCheckout(): Promise<void> {
    const page = this.syncPage();
    let checkout = await visibleFirst([
      page.getByRole("button", {
        name: /go to checkout|checkout|view (?:order|cart)|przejdź do kasy|zobacz koszyk|zamówienie/i,
      }),
      page.getByRole("link", {
        name: /go to checkout|checkout|view (?:order|cart)|przejdź do kasy|zobacz koszyk|zamówienie/i,
      }),
    ]);
    if (checkout) {
      await checkout.click();
      await page.waitForTimeout(1_000);
      checkout = await visibleFirst([
        page.getByRole("button", {
          name: /go to checkout|checkout|przejdź do kasy|zamawiam/i,
        }),
        page.getByRole("link", {
          name: /go to checkout|checkout|przejdź do kasy/i,
        }),
      ]);
      if (checkout) {
        await checkout.click();
        await page.waitForTimeout(1_000);
      }
    }

    await this.ensurePyszneLoginIfNeeded();

    const text = await this.bodyText();
    if (
      !/checkout|order summary|payment|podsumowanie|płatność|do zapłaty|razem/i.test(
        text,
      )
    ) {
      await requireExactConfirmation(
        `Open the cart in ${this.site.label} and continue until the final checkout summary is visible. Do not click the final order/pay button.`,
        `${this.site.adapter.toLocaleUpperCase()} CHECKOUT READY`,
      );
    }
    this.assertProviderPage(this.syncPage());
  }

  private async ensurePyszneLoginIfNeeded(): Promise<void> {
    if (this.site.adapter !== "pyszne") return;
    let page = this.syncPage();
    const needsLogin =
      new URL(page.url()).hostname.toLocaleLowerCase() === "auth.pyszne.pl" ||
      (await isVisible(
        page.getByRole("heading", { name: /log in or create account/i }),
      ));
    if (!needsLogin) return;

    if (
      this.options.pyszneLoginMode !== "agentmail" ||
      this.options.mailSource !== "agentmail"
    ) {
      await requireExactConfirmation(
        `Complete Pyszne.pl email login in the dedicated browser and return to the checkout summary.`,
        "PYSZNE LOGGED IN",
      );
    } else {
      if (
        this.config.contact_email.toLocaleLowerCase() !==
        this.options.agentMailInbox
      ) {
        throw new Error(
          "Pyszne AgentMail login requires contact_email to equal the dedicated AgentMail inbox",
        );
      }
      const email = await visibleFirst([
        page.getByRole("textbox", { name: /continue with email|email/i }),
        page.getByPlaceholder(/email/i),
        page.locator('input[type="email"]'),
      ]);
      if (!email) {
        throw new Error("Pyszne email login field was not visible");
      }
      const existingMessages = await listRecentPyszneMessageIds(this.options);
      await requireExactConfirmation(
        [
          "Pyszne.pl says that proceeding with email accepts its Terms and Conditions, Privacy Statement, and Cookie Policy.",
          `The agent will submit ${this.config.contact_email} only to auth.pyszne.pl for this checkout login.`,
          "No card data or payment action is involved.",
        ].join("\n"),
        "PYSZNE ACCEPT TERMS AND LOGIN",
      );
      const requestedAt = new Date(Date.now() - 120_000);
      // Submit from the email input itself. Never search for a generic
      // "Continue" button here: Pyszne also renders Google/Facebook provider
      // buttons whose accessible names contain that word.
      await submitPyszneEmailLogin(email, this.config.contact_email);
      console.log(
        `Waiting for a fresh Pyszne login message at ${this.options.agentMailInbox}.`,
      );
      try {
        const challenge = await pollForPyszneLoginChallenge(
          this.options,
          requestedAt,
          existingMessages,
        );
        page = this.syncPage();
        if (challenge.kind === "link") {
          await page.goto(challenge.link, { waitUntil: "domcontentloaded" });
        } else {
          const otpFields = page.locator(
            'input[autocomplete="one-time-code"], input[name*="code" i], input[id*="code" i], input[maxlength="1"]',
          );
          const count = await otpFields.count();
          if (count === 1) {
            await otpFields.first().fill(challenge.otp);
          } else if (count >= 6) {
            for (let index = 0; index < 6; index += 1) {
              await otpFields.nth(index).fill(challenge.otp[index] ?? "");
            }
          } else {
            const codeField = await visibleFirst([
              page.getByRole("textbox", {
                name: /verification code|login code|enter.*code/i,
              }),
              page.getByPlaceholder(
                /verification code|login code|enter.*code/i,
              ),
            ]);
            if (!codeField) {
              throw new Error("Pyszne login code fields were not visible");
            }
            await codeField.fill(challenge.otp);
          }
          const verify = await visibleFirst([
            page.getByRole("button", { name: /verify|continue|log in|dalej/i }),
          ]);
          if (verify) await verify.click();
          else await otpFields.last().press("Enter");
        }
        await page.waitForTimeout(1_500);
      } catch (error) {
        console.log(
          `Automatic Pyszne AgentMail login stopped safely: ${(error as Error).message}`,
        );
        await requireExactConfirmation(
          "Finish Pyszne email login in the dedicated browser, then return to the checkout summary.",
          "PYSZNE LOGGED IN",
        );
      }
    }

    page = this.syncPage();
    const stillLogin =
      new URL(page.url()).hostname.toLocaleLowerCase() === "auth.pyszne.pl" ||
      (await isVisible(
        page.getByRole("heading", { name: /log in or create account/i }),
      ));
    if (stillLogin) {
      throw new Error(
        "Pyszne login was not completed; checkout remains on auth.pyszne.pl",
      );
    }
    this.assertProviderPage(page);
    console.log("Pyszne email login completed in the dedicated profile.");
  }

  async searchOrOpen(): Promise<void> {
    verifyConfirmation(this.config, this.options, this.note);
    try {
      this.context = await chromium.launchPersistentContext(
        this.site.profileDir(this.options),
        {
          channel: this.options.browserChannel,
          headless: false,
          viewport: null,
          args: ["--disable-blink-features=AutomationControlled"],
        },
      );
    } catch (error) {
      if (
        /Opening in existing browser session|profile.*in use/i.test(
          (error as Error).message,
        )
      ) {
        throw new Error(
          `${this.site.label} profile is already open. Quit only its dedicated Chrome window and rerun npm run order:prepare.`,
        );
      }
      throw error;
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    await this.page.goto(this.site.startUrl, { waitUntil: "domcontentloaded" });
    this.assertProviderPage(this.page);
    await this.dismissCookies();
  }

  async buildCartOrOrderForm(): Promise<void> {
    await this.ensureDestinationForBrowsing();
    try {
      await this.tryAutomaticSingleItem();
    } catch (error) {
      console.log(
        `Automatic ${this.site.label} item selection stopped safely: ${(error as Error).message}`,
      );
      await requireExactConfirmation(
        [
          `Use the visible ${this.site.label} window to add only:`,
          ...this.config.items.map((item) => `${item.qty} × ${item.query}`),
          "Open the cart when it is ready.",
        ].join("\n"),
        `${this.site.adapter.toLocaleUpperCase()} CART READY`,
      );
    }
    let cartText = await this.bodyText();
    if (/substitute all unavailable items with best match/i.test(cartText)) {
      await requireExactConfirmation(
        `In the ${this.site.label} basket, open the substitution setting and choose no substitutions. The merchant must not replace an approved item with an unreviewed item.`,
        "SUBSTITUTIONS OFF",
      );
      cartText = await this.bodyText();
      if (/substitute all unavailable items with best match/i.test(cartText)) {
        throw new Error(
          "best-match substitutions still appear enabled; checkout is blocked",
        );
      }
    }
    const minimumOrder = parseRemainingMinimumOrder(cartText);
    if (minimumOrder !== null) {
      throw new Error(
        `merchant minimum order is not met; basket still requires ${minimumOrder.toFixed(2)} PLN. Add only a separately approved item and rerun the checklist.`,
      );
    }
    const foldedCart = foldText(cartText);
    for (const item of this.config.items) {
      if (!foldedCart.includes(foldText(item.query))) {
        throw new Error(
          `basket does not visibly contain approved item ${JSON.stringify(item.query)}`,
        );
      }
    }
    this.assertProviderPage(this.syncPage());
    await this.syncPage().screenshot({
      path: screenshotPath("cart.png"),
      fullPage: true,
    });
    await this.openCheckout();
  }

  async fillDestination(): Promise<void> {
    if (!this.destinationPrepared) await this.ensureDestinationForBrowsing();
    const page = this.syncPage();
    if (!this.site.supportsGuestCheckout) {
      const login = await visibleFirst([
        page.getByRole("button", { name: /log in|zaloguj/i }),
        page.getByRole("link", { name: /log in|zaloguj/i }),
      ]);
      if (login) {
        await requireExactConfirmation(
          `Complete ${this.site.label} login in the dedicated window. Handle any CAPTCHA or phone/email verification yourself, then return here.`,
          `${this.site.adapter.toLocaleUpperCase()} LOGGED IN`,
        );
      }
    }
    await requireExactConfirmation(
      `The agent is ready to transmit the configured venue contact details to ${this.site.label}: recipient ${JSON.stringify(this.config.recipient_name)}, phone ending ${this.config.phone?.slice(-4) ?? "NONE"}, and ${this.config.contact_email}.`,
      "SEND VENUE DATA",
    );

    const fields: Array<[Locator[], string]> = [
      [
        [
          page.getByLabel(
            /full name|recipient.*name|name and surname|imię.*nazwisko/i,
          ),
          page.getByPlaceholder(
            /full name|recipient.*name|name and surname|imię.*nazwisko/i,
          ),
        ],
        this.config.recipient_name,
      ],
      [
        [
          page.getByLabel(/phone|telefon/i),
          page.getByPlaceholder(/phone|telefon/i),
          page.locator('input[type="tel"]'),
        ],
        this.config.phone ?? "",
      ],
      [
        [
          page.getByLabel(/email|e-mail/i),
          page.getByPlaceholder(/email|e-mail/i),
          page.locator('input[type="email"]'),
        ],
        this.config.contact_email,
      ],
    ];
    for (const [locators, value] of fields) {
      const field = await visibleFirst(locators);
      if (field && value) await field.fill(value);
    }

    const text = foldText(await this.bodyText());
    if (!text.includes("krakow") && !/krakow/i.test(page.url())) {
      throw new Error("checkout destination city is not visibly Kraków");
    }
    await page.screenshot({
      path: screenshotPath("address.png"),
      fullPage: true,
    });
  }

  async attachNote(): Promise<void> {
    const page = this.syncPage();
    let input = await visibleFirst([
      page.getByLabel(
        /delivery note|courier note|instructions|uwagi|instrukcje|notatka/i,
      ),
      page.getByPlaceholder(
        /delivery note|courier note|instructions|uwagi|instrukcje|notatka/i,
      ),
      page.locator('textarea[name*="note" i], textarea[name*="comment" i]'),
    ]);
    if (!input) {
      const opener = await visibleFirst([
        page.getByRole("button", {
          name: /add.*note|add.*instruction|dodaj.*uwag|instrukcje/i,
        }),
        page.getByText(/add.*note|add.*instruction|dodaj.*uwag/i),
      ]);
      if (opener) {
        await opener.click();
        input = await visibleFirst([
          page.getByLabel(
            /delivery note|courier note|instructions|uwagi|instrukcje|notatka/i,
          ),
          page.getByPlaceholder(
            /delivery note|courier note|instructions|uwagi|instrukcje|notatka/i,
          ),
          page.locator("textarea"),
        ]);
      }
    }
    if (input) {
      await input.fill(this.note);
      if ((await input.inputValue()) !== this.note) {
        throw new Error("delivery note did not render exactly as configured");
      }
    } else {
      await requireExactConfirmation(
        `Enter this exact delivery note in ${this.site.label}: ${JSON.stringify(this.note)}`,
        `${this.site.adapter.toLocaleUpperCase()} NOTE READY`,
      );
    }
  }

  async quote(): Promise<QuoteOutput> {
    const page = this.syncPage();
    this.assertProviderPage(page);
    const checkoutText = await this.bodyText();
    if (!FOOD_SIGNALS.test(checkoutText)) {
      throw new Error(
        "checkout could not be verified as a food-delivery order",
      );
    }
    await assertNoSaveCardPrompt(page);
    await page.screenshot({
      path: screenshotPath("paywall.png"),
      fullPage: true,
    });
    const requestedAt = new Date();
    writeJson("mcp-quote-request.json", {
      driver: "mcp_visual",
      adapter: this.site.adapter,
      source_url: page.url(),
      approved_items: this.config.items,
      address_line: this.config.address_line,
      recipient_name: this.config.recipient_name,
      note: this.note,
      max_pln: this.config.max_pln,
      screenshot: screenshotPath("paywall.png"),
      requested_at: requestedAt.toISOString(),
      payment_method_must_remain_closed: true,
    });
    await requireExactConfirmation(
      [
        "MCP visual quote extraction is required; DOM price parsing is disabled for this adapter.",
        "Ask the supervising AI to inspect the visible final checkout, write agent/out/mcp-browser-observation.json, and validate every line item and fee.",
        "Do not open a payment method or click Order and pay.",
      ].join("\n"),
      "MCP QUOTE READY",
    );
    const observed = readJson<McpBrowserObservation>(
      "mcp-browser-observation.json",
    );
    const quote = validateMcpBrowserObservation(
      this.config,
      this.note,
      observed,
      requestedAt,
    );
    this.amountPln = quote.landed_pln;
    if (this.amountPln === null)
      throw new Error("MCP quote has no landed total");
    writeJson("quote.json", quote);
    console.log(
      `${this.site.label} MCP-verified final landed quote: ${this.amountPln.toFixed(2)} PLN <= ${this.config.max_pln.toFixed(2)} PLN.`,
    );
    return quote;
  }

  async stopAtPaywall(): Promise<void> {
    if (this.amountPln === null) throw new Error("final quote is missing");
    if (this.options.allowPay) {
      throw new Error(
        `${this.site.label} automatic payment is not implemented or rehearsed; Pay was not clicked. Set ALLOW_PAY=false for the dry run.`,
      );
    }
    await humanPaymentHandoff(this.syncPage(), this.amountPln);
  }

  async close(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.page = null;
  }
}

export const GLOVO_SITE: BrowserFoodSite = {
  adapter: "glovo",
  label: "Glovo",
  host: "glovoapp.com",
  startUrl: "https://glovoapp.com/pl/pl/krakow",
  profileDir: (options) => options.glovoProfileDir,
  supportsGuestCheckout: false,
};

export const PYSZNE_SITE: BrowserFoodSite = {
  adapter: "pyszne",
  label: "Pyszne.pl",
  host: "pyszne.pl",
  startUrl: "https://www.pyszne.pl/en",
  profileDir: (options) => options.pyszneProfileDir,
  supportsGuestCheckout: true,
};
