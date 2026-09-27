import {
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "playwright-core";
import { citySlug, configHash, loadCardSecrets } from "./config.js";
import { listRecentWoltMessageIds, pollForWoltLoginLink } from "./agentmail.js";
import { readJson, screenshotPath } from "./files.js";
import { pollForOtp } from "./mail.js";
import { beginSingleCardAttempt } from "./policy.js";
import { requireExactConfirmation } from "./prompts.js";
import { parseCheckoutTotal } from "./quote.js";
import { assertSaveCardDisabled } from "./save-card-policy.js";
import type {
  AgentConfig,
  PaidOutput,
  QuoteOutput,
  RuntimeOptions,
  ThreeDsAudit,
} from "./types.js";

interface HumanConfirmation {
  config_sha256: string;
  confirmed_at: string;
  max_pln: number;
  allow_pay: boolean;
  allow_3ds_submit: boolean;
  allow_save_card: boolean;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const FOOD_URL = /\/pol\/krakow\/(?:restaurant|venue)\//i;
const FOOD_SIGNALS =
  /sernik|pastry|ciast|cake|croissant|rogal|pącz|snack|drożdż|donut|muffin|brownie|cookie|bakery|piekarni|cukierni|cafe|kawiarnia/i;

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

async function clickFirst(locators: Locator[], label: string): Promise<void> {
  const locator = await visibleFirst(locators);
  if (!locator) throw new Error(`could not safely locate ${label}`);
  await locator.click();
}

async function fillFirst(
  locators: Locator[],
  value: string,
  label: string,
): Promise<Locator> {
  const locator = await visibleFirst(locators);
  if (!locator) throw new Error(`could not safely locate ${label}`);
  await locator.fill(value);
  return locator;
}

export function verifyConfirmation(
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): void {
  const confirmation = readJson<HumanConfirmation>("human-confirmation.json");
  if (confirmation.config_sha256 !== configHash(config, note)) {
    throw new Error(
      "config changed after checklist approval; run npm run checklist again",
    );
  }
  if (
    confirmation.max_pln !== config.max_pln ||
    confirmation.allow_pay !== options.allowPay ||
    confirmation.allow_3ds_submit !== options.allowThreeDsSubmit ||
    confirmation.allow_save_card !== options.allowSaveCard
  ) {
    throw new Error(
      "payment flags or max_pln changed after checklist approval",
    );
  }
  const confirmedAt = new Date(confirmation.confirmed_at);
  if (
    Number.isNaN(confirmedAt.valueOf()) ||
    Date.now() - confirmedAt.valueOf() > 30 * 60_000
  ) {
    throw new Error(
      "checklist approval is older than 30 minutes; confirm again",
    );
  }
}

export async function dismissCookieConsent(page: Page): Promise<void> {
  const overlay = page.locator('[data-test-id="consents-banner-overlay"]');
  try {
    await overlay.waitFor({ state: "visible", timeout: 3_000 });
  } catch {
    return;
  }
  const necessaryOnly = await visibleFirst([
    overlay.getByRole("button", {
      name: /necessary only|only necessary|reject|odrzuć|tylko niezbędne/i,
    }),
    page.getByRole("button", {
      name: /necessary only|only necessary|reject|odrzuć|tylko niezbędne/i,
    }),
  ]);
  if (necessaryOnly) {
    await necessaryOnly.click();
  } else {
    const accept = await visibleFirst([
      overlay.getByRole("button", {
        name: /accept all|allow all|agree|akceptuj wszystkie|zgadzam się/i,
      }),
      page.getByRole("button", {
        name: /accept all|allow all|agree|akceptuj wszystkie|zgadzam się/i,
      }),
    ]);
    if (!accept) {
      throw new Error(
        "Wolt cookie banner is present but has no recognized choice",
      );
    }
    await accept.click();
  }
  await overlay.waitFor({ state: "hidden", timeout: 10_000 });
}

async function openVerifiedAuthenticatedPage(
  context: BrowserContext,
  config: AgentConfig,
): Promise<Page> {
  const verificationPage = await context.newPage();
  const city = citySlug(config.city);
  await verificationPage.goto(`https://wolt.com/en/pol/${city}`, {
    waitUntil: "domcontentloaded",
    timeout: LOGIN_TIMEOUT_MS,
  });
  await dismissCookieConsent(verificationPage);

  const login = verificationPage.getByRole("button", {
    name: /log in|zaloguj/i,
  });
  const signup = verificationPage.getByRole("button", {
    name: /sign up|zarejestruj/i,
  });
  if ((await isVisible(login)) || (await isVisible(signup))) {
    await verificationPage.close();
    throw new Error(
      "Wolt still shows Log in / Sign up on a fresh Kraków page; authentication was not completed",
    );
  }
  return verificationPage;
}

export async function ensureLoggedIn(
  page: Page,
  config: AgentConfig,
  options: RuntimeOptions,
): Promise<Page> {
  const login = page.getByRole("button", { name: /log in|zaloguj/i });
  if (!(await isVisible(login))) return page;
  const context = page.context();
  if (
    options.woltLoginMode === "agentmail" &&
    options.mailSource === "agentmail" &&
    config.contact_email.toLocaleLowerCase() === options.agentMailInbox
  ) {
    await login.click();
    const email = await fillFirst(
      [
        page.getByRole("textbox", { name: /enter your email|email/i }),
        page.getByPlaceholder(/enter your email|email/i),
        page.locator('input[type="email"]'),
      ],
      config.contact_email,
      "Wolt login email",
    );
    const existingWoltMessages = await listRecentWoltMessageIds(options);
    // AgentMail/Wolt timestamps can differ slightly from the laptop clock.
    // Message-ID exclusion prevents this tolerance from accepting old links.
    const requestedAt = new Date(Date.now() - 120_000);
    const sendLink = await visibleFirst([
      page.getByRole("button", { name: /^continue$/i }),
      page.getByRole("button", { name: /continue with email/i }),
      page.getByRole("button", { name: /send.*link|log in with email/i }),
    ]);
    if (sendLink) await sendLink.click();
    else await email.press("Enter");
    console.log(
      `Waiting for a fresh Wolt sign-in link at ${options.agentMailInbox}.`,
    );
    try {
      const link = await pollForWoltLoginLink(
        options,
        requestedAt,
        existingWoltMessages,
      );
      await page.goto(link, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1_500);
    } catch (error) {
      console.log(
        `Automatic Wolt magic-link wait ended: ${(error as Error).message}.`,
      );
      await requireExactConfirmation(
        [
          "The dedicated controlled Chrome window will stay open.",
          "Finish login inside that exact window: request/resend the email, then paste the fresh Wolt link into that window's address bar, or use Wolt's phone login there.",
          "Do not open the link in your ordinary Chrome profile.",
          "Confirm only when Log in / Sign up has disappeared.",
        ].join("\n"),
        "WOLT LOGGED IN",
      );
    }
    const authenticatedPage = await openVerifiedAuthenticatedPage(
      context,
      config,
    );
    console.log(
      "Wolt sign-in completed through the dedicated AgentMail inbox.",
    );
    return authenticatedPage;
  }
  console.log("Wolt login is required in the persistent browser window.");
  console.log(
    "Log in manually, then return here. No password is read by the agent.",
  );
  await requireExactConfirmation(
    "Complete Wolt login in the visible browser. Confirm only after the login dialog has closed and the top-right account control replaces Log in / Sign up.",
    "WOLT LOGGED IN",
  );

  return openVerifiedAuthenticatedPage(context, config);
}

async function automateOneItem(
  page: Page,
  query: string,
  qty: number,
): Promise<void> {
  if (qty !== 1) {
    throw new Error(
      "automatic cart mode supports qty=1 only; use the visible browser to set a larger approved quantity",
    );
  }
  const search = await visibleFirst([
    page.getByPlaceholder("Search in Wolt...", { exact: true }),
    page.getByPlaceholder(/search/i),
  ]);
  if (!search) throw new Error("Wolt search input was not found");
  await search.fill(query);
  await search.press("Enter");
  await page.waitForTimeout(1_500);

  const queryPattern = new RegExp(escapeRegExp(query), "i");
  const venueLinks = page.locator(
    'a[href*="/pol/krakow/restaurant/"], a[href*="/pol/krakow/venue/"]',
  );
  const candidates = venueLinks.filter({ hasText: queryPattern });
  if ((await candidates.count()) < 1) {
    throw new Error(
      `no food-delivery search result visibly matched ${JSON.stringify(query)}`,
    );
  }
  await candidates.first().click();
  await page.waitForLoadState("domcontentloaded");

  if (!FOOD_URL.test(page.url())) {
    throw new Error(`merchant URL is not a Kraków food venue: ${page.url()}`);
  }
  const pageText = await page.locator("body").innerText();
  if (!FOOD_SIGNALS.test(`${query}\n${pageText}`)) {
    throw new Error(
      "merchant page could not be verified as pastry/snack food delivery",
    );
  }

  const item = page.getByText(queryPattern).first();
  if (!(await isVisible(item))) {
    throw new Error(
      `approved item ${JSON.stringify(query)} was not visible on the food venue page`,
    );
  }
  await item.click();
  await clickFirst(
    [
      page.getByRole("button", { name: /add to order/i }),
      page.getByRole("button", { name: /add to cart/i }),
      page.getByRole("button", { name: /^add\b/i }),
      page.getByRole("button", { name: /dodaj/i }),
    ],
    "Add to order button",
  );
}

export async function addApprovedItems(
  page: Page,
  config: AgentConfig,
): Promise<void> {
  const existingCart = await visibleFirst([
    page.getByRole("button", { name: /view order|go to checkout|checkout/i }),
    page.getByText(/view order/i),
  ]);
  if (existingCart) {
    await requireExactConfirmation(
      "An existing Wolt cart was detected. In the visible browser, remove every item so this run starts from an empty cart.",
      "CART CLEARED",
    );
    const cartAfterClear = await visibleFirst([
      page.getByRole("button", {
        name: /view order|go to checkout|checkout/i,
      }),
      page.getByText(/view order/i),
    ]);
    if (cartAfterClear) {
      throw new Error(
        "CART CLEARED was confirmed but Wolt still shows an existing cart",
      );
    }
  }

  try {
    for (const item of config.items) {
      await automateOneItem(page, item.query, item.qty);
    }
  } catch (error) {
    console.log(
      `Automatic item selection stopped safely: ${(error as Error).message}`,
    );
    console.log(
      "Use the visible Wolt window to add only the approved items and quantities.",
    );
    await requireExactConfirmation(
      `Approved cart:\n${config.items.map((item) => `${item.qty} × ${item.query}`).join("\n")}`,
      "CART READY",
    );
  }

  if (page.isClosed()) {
    throw new Error(
      "the controlled Wolt tab was closed; CART READY cannot be verified",
    );
  }
  let checkout = await visibleFirst([
    page.getByRole("button", {
      name: /go to checkout|checkout|przejdź do kasy/i,
    }),
    page.getByRole("link", {
      name: /go to checkout|checkout|przejdź do kasy/i,
    }),
  ]);
  if (!checkout) {
    const viewCart = await visibleFirst([
      page
        .locator("button")
        .filter({ hasText: /view order|view cart|zobacz zamówienie/i }),
      page
        .locator('[role="button"]')
        .filter({ hasText: /view order|view cart|zobacz zamówienie/i }),
      page.getByRole("button", {
        name: /view order|view cart|zobacz zamówienie/i,
      }),
    ]);
    if (viewCart) {
      await viewCart.click({ timeout: 5_000 });
      await page.waitForTimeout(750);
      checkout = await visibleFirst([
        page.getByRole("button", {
          name: /go to checkout|checkout|przejdź do kasy/i,
        }),
        page.getByRole("link", {
          name: /go to checkout|checkout|przejdź do kasy/i,
        }),
      ]);
    }
  }
  if (!checkout) {
    throw new Error(
      "CART READY was confirmed but no Wolt cart/checkout control was visible",
    );
  }
  for (const item of config.items) {
    const approvedItem = page.getByText(
      new RegExp(escapeRegExp(item.query), "i"),
    );
    if (!(await isVisible(approvedItem))) {
      throw new Error(
        `cart does not visibly contain approved item ${JSON.stringify(item.query)}`,
      );
    }
  }
  await page.screenshot({ path: screenshotPath("cart.png"), fullPage: true });
}

export async function openCheckout(page: Page): Promise<void> {
  let checkout = await visibleFirst([
    page.getByRole("button", { name: /go to checkout|checkout/i }),
    page.getByRole("link", { name: /go to checkout|checkout/i }),
  ]);
  if (!checkout) {
    await clickFirst(
      [
        page
          .locator("button")
          .filter({ hasText: /view order|view cart|zobacz zamówienie/i }),
        page
          .locator('[role="button"]')
          .filter({ hasText: /view order|view cart|zobacz zamówienie/i }),
        page.getByRole("button", { name: /view order|view cart/i }),
      ],
      "cart button",
    );
    await page.waitForTimeout(750);
    checkout = await visibleFirst([
      page.getByRole("button", { name: /go to checkout|checkout/i }),
      page.getByRole("link", { name: /go to checkout|checkout/i }),
    ]);
  }
  if (!checkout) throw new Error("Wolt checkout button was not visible");
  await checkout.click();
  await page.waitForTimeout(1_500);
  await requireExactConfirmation(
    "Verify that the visible Wolt window shows its checkout/delivery-details surface. If the cart drawer is still open, click the blue Go to checkout button once.",
    "CHECKOUT READY",
  );

  if (page.isClosed()) {
    throw new Error(
      "the controlled Wolt tab was closed; checkout cannot be verified",
    );
  }
  const checkoutBody = await page.locator("body").innerText();
  const checkoutUrl = page.url();
  const checkoutReached =
    /checkout/i.test(checkoutUrl) ||
    /delivery (?:details|address)|order summary|payment method|where should we deliver/i.test(
      checkoutBody,
    );
  const cartCheckoutStillVisible = await visibleFirst([
    page.getByRole("button", { name: /go to checkout/i }),
    page.getByRole("link", { name: /go to checkout/i }),
  ]);
  if (!checkoutReached && cartCheckoutStillVisible) {
    throw new Error(
      "CHECKOUT READY was confirmed but Wolt still visibly shows Go to checkout",
    );
  }
  await page.screenshot({
    path: screenshotPath("checkout.png"),
    fullPage: true,
  });
}

async function selectAddressSuggestion(
  page: Page,
  config: AgentConfig,
): Promise<void> {
  const options = page.getByRole("option");
  const count = await options.count();
  if (count < 1) {
    const addressText = page.getByText(config.address_line, { exact: false });
    if (!(await isVisible(addressText))) {
      throw new Error("no delivery-address suggestion was available");
    }
    await addressText.first().click();
    return;
  }

  const streetKey = foldText(config.address_line.split(",")[0]?.trim() ?? "");
  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const text = foldText(await option.innerText());
    if (text.includes(streetKey) && text.includes("krakow")) {
      await option.click();
      return;
    }
  }
  throw new Error(
    "address suggestions did not match both the configured street and Kraków",
  );
}

export async function fillDeliveryDetails(
  page: Page,
  config: AgentConfig,
): Promise<void> {
  await requireExactConfirmation(
    `The agent is ready to transmit the configured venue address, recipient name, masked phone ending ${config.phone?.slice(-4) ?? "NONE"}, and contact email to Wolt.`,
    "SEND VENUE DATA",
  );

  const streetKey = foldText(config.address_line.split(",")[0]?.trim() ?? "");
  const initialAddressBody = foldText(await page.locator("body").innerText());
  const addressAlreadySelected = initialAddressBody.includes(streetKey);

  if (!addressAlreadySelected) {
    const changeAddress = await visibleFirst([
      page.locator("button").filter({ hasText: /^krak[oó]w$/i }),
      page.locator('[role="button"]').filter({ hasText: /^krak[oó]w$/i }),
      page.getByRole("button", { name: /^krak[oó]w$/i }),
      page.getByText(/^krak[oó]w$/i),
      page.getByRole("button", { name: /please add a delivery address/i }),
      page.getByText(/please add a delivery address/i),
      page.getByRole("button", {
        name: /change.*address|add.*address|enter.*address|delivery address|delivery location/i,
      }),
      page.getByRole("link", {
        name: /change.*address|add.*address|enter.*address|delivery address|delivery location/i,
      }),
      page.getByText(
        /change.*address|add.*address|enter.*address|delivery address/i,
      ),
    ]);
    if (changeAddress) {
      await changeAddress.click();
      await page.waitForTimeout(500);
    }

    const address = await visibleFirst([
      page.getByPlaceholder(
        /delivery address|enter.*address|search.*address|street address|where.*deliver|address/i,
      ),
      page.getByLabel(
        /delivery address|enter.*address|search.*address|street address|where.*deliver|address/i,
      ),
      page.locator('input[autocomplete="street-address"]'),
    ]);
    if (address) {
      await address.fill(config.address_line);
      await page.waitForTimeout(800);
      await selectAddressSuggestion(page, config);
      await page.waitForTimeout(750);
    } else {
      await requireExactConfirmation(
        `Wolt did not expose its address input to automation. In the visible browser, click Kraków, enter ${JSON.stringify(config.address_line)}, select the Kraków suggestion, and return to checkout.`,
        "ADDRESS READY",
      );
    }
  }

  const addressBody = foldText(await page.locator("body").innerText());
  const cityConfirmed =
    addressBody.includes("krakow") || /\/pol\/krakow(?:\/|$)/i.test(page.url());
  if (!addressBody.includes(streetKey) || !cityConfirmed) {
    throw new Error(
      "checkout does not visibly confirm the configured Kraków venue address",
    );
  }

  const giftDetails = await visibleFirst([
    page.getByRole("button", { name: /send as a gift/i }),
    page.getByText(/send as a gift/i),
  ]);
  if (giftDetails) {
    await giftDetails.click();
    await page.waitForTimeout(500);
  }

  const giftNameFields = page.getByLabel(/^name$/i);
  const giftNameCount = await giftNameFields.count();
  const recipientName =
    giftNameCount >= 2
      ? giftNameFields.nth(giftNameCount - 1)
      : await visibleFirst([
          page.getByLabel(/recipient.*name/i),
          page.getByPlaceholder(/recipient.*name/i),
        ]);
  const recipientPhone = await visibleFirst([
    page.getByLabel(/recipient.*phone|phone number/i),
    page.getByPlaceholder(/recipient.*phone|phone number/i),
  ]);
  if (recipientName && (await isVisible(recipientName)) && recipientPhone) {
    await recipientName.fill(config.recipient_name);
    let phoneForField = config.phone ?? "";
    if (phoneForField.startsWith("+1")) {
      const regionCode = await visibleFirst([
        page.getByRole("button", { name: /PL\s*\+48|region code/i }),
        page.locator('[role="button"]').filter({ hasText: /PL\s*\+48/i }),
      ]);
      if (regionCode) {
        await regionCode.click();
        await page.waitForTimeout(300);
        const unitedStates = await visibleFirst([
          page.getByRole("option", {
            name: /united states.*\+1|US.*\+1/i,
          }),
          page.getByRole("button", {
            name: /united states.*\+1|US.*\+1/i,
          }),
          page.getByText(/united states.*\+1|🇺🇸.*\+1/i),
        ]);
        if (unitedStates) {
          await unitedStates.click();
          phoneForField = phoneForField.slice(2);
        }
      }
    }
    await recipientPhone.fill(phoneForField);
    const saveGift = await visibleFirst([
      page.getByRole("button", { name: /^save$/i }),
      page.getByRole("button", { name: /save gift/i }),
    ]);
    if (!saveGift) {
      throw new Error("gift recipient fields were filled but Save was absent");
    }
    await saveGift.click();
    await page.waitForTimeout(600);
    const giftModalStillOpen = await isVisible(
      page.getByText(/^personalize your gift$/i),
    );
    if (giftModalStillOpen) {
      await requireExactConfirmation(
        `Wolt did not accept the recipient phone automatically. In Personalize your gift, select the correct +1 region for the configured phone ending ${config.phone?.slice(-4) ?? "NONE"}, correct the number, and click Save.`,
        "RECIPIENT READY",
      );
    }
  } else {
    await requireExactConfirmation(
      `Wolt did not expose both gift-recipient fields. In the visible browser, open Send as a gift, set recipient ${JSON.stringify(config.recipient_name)} with the configured phone ending ${config.phone?.slice(-4) ?? "NONE"}, and click Save.`,
      "RECIPIENT READY",
    );
  }
  const email = await visibleFirst([
    page.getByLabel(/email/i),
    page.getByPlaceholder(/email/i),
  ]);
  if (email) await email.fill(config.contact_email);

  const finalBody = foldText(await page.locator("body").innerText());
  const finalCityConfirmed =
    finalBody.includes("krakow") || /\/pol\/krakow(?:\/|$)/i.test(page.url());
  if (!finalCityConfirmed) {
    throw new Error(
      "checkout page does not visibly confirm destination city Kraków",
    );
  }
}

export async function attachDeliveryNote(
  page: Page,
  note: string,
): Promise<void> {
  let noteInput = await visibleFirst([
    page.getByLabel(
      /delivery note|courier note|(?:add )?note for (?:the )?courier|instructions/i,
    ),
    page.getByPlaceholder(
      /delivery note|courier note|(?:add )?note for (?:the )?courier|instructions/i,
    ),
    page.locator('textarea[name*="note" i]'),
  ]);
  if (!noteInput) {
    const noteOpener = await visibleFirst([
      page.getByRole("button", { name: /add note for (?:the )?courier/i }),
      page.getByText(/add note for (?:the )?courier/i),
    ]);
    if (noteOpener) {
      await noteOpener.click();
      await page.waitForTimeout(400);
      noteInput = await visibleFirst([
        page.getByLabel(
          /delivery note|courier note|(?:add )?note for (?:the )?courier|instructions/i,
        ),
        page.getByPlaceholder(
          /delivery note|courier note|(?:add )?note for (?:the )?courier|instructions/i,
        ),
        page.locator('textarea[name*="note" i]'),
      ]);
    }
  }
  if (noteInput) {
    await noteInput.fill(note);
    if ((await noteInput.inputValue()) !== note) {
      throw new Error("delivery note did not render exactly as configured");
    }
  } else {
    await requireExactConfirmation(
      `Wolt did not expose the courier-note field. In the visible browser, open Add note for courier and enter exactly ${JSON.stringify(note)}.`,
      "NOTE READY",
    );
  }

  await page.screenshot({
    path: screenshotPath("address.png"),
    fullPage: true,
  });
}

export async function assertNoSaveCardPrompt(page: Page): Promise<void> {
  const savePattern =
    /save.*card|remember.*card|store.*card|zapisz.*kart|zapamiętaj.*kart/i;
  for (const frame of page.frames()) {
    const promptVisible = await isVisible(frame.getByText(savePattern));
    if (!promptVisible) continue;
    const control = await visibleFirst([
      frame.getByRole("checkbox", { name: savePattern }),
      frame.getByRole("switch", { name: savePattern }),
    ]);
    assertSaveCardDisabled({
      promptVisible,
      controlVisible: control !== null,
      checked: control ? await control.isChecked() : null,
    });
  }
}

async function fillAcrossFrames(
  page: Page,
  candidates: ((frame: Frame) => Locator)[],
  value: string,
  label: string,
): Promise<void> {
  for (const frame of page.frames()) {
    for (const candidate of candidates) {
      const locator = candidate(frame);
      if (await isVisible(locator)) {
        await locator.first().fill(value);
        return;
      }
    }
  }
  throw new Error(`could not safely locate ${label} in payment frames`);
}

async function fillOptionalAcrossFrames(
  page: Page,
  candidates: ((frame: Frame) => Locator)[],
  value: string,
): Promise<boolean> {
  for (const frame of page.frames()) {
    for (const candidate of candidates) {
      const locator = candidate(frame);
      if (await isVisible(locator)) {
        await locator.first().fill(value);
        return true;
      }
    }
  }
  return false;
}

async function visibleFirstAcrossFrames(
  page: Page,
  candidates: ((frame: Frame) => Locator)[],
): Promise<Locator | null> {
  for (const frame of page.frames()) {
    for (const candidate of candidates) {
      const locator = candidate(frame);
      if (await isVisible(locator)) return locator.first();
    }
  }
  return null;
}

async function waitForVisibleAcrossFrames(
  page: Page,
  candidates: ((frame: Frame) => Locator)[],
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const visible = await visibleFirstAcrossFrames(page, candidates);
    if (visible) return visible;
    await page.waitForTimeout(500);
  }
  return null;
}

export async function fillCard(
  page: Page,
  options: RuntimeOptions,
  amountPln: number,
  onAttemptStarted: (cardLast4: string) => Promise<void>,
): Promise<string> {
  const card = loadCardSecrets(options);
  await assertNoSaveCardPrompt(page);

  const assertAmountUnchanged = async (stage: string): Promise<void> => {
    const currentAmount = parseCheckoutTotal(
      await page.locator("body").innerText(),
    );
    if (Math.abs(currentAmount - amountPln) > 0.01) {
      throw new Error(
        `checkout total changed ${stage}: quoted ${amountPln.toFixed(2)} PLN, now ${currentAmount.toFixed(2)} PLN; payment is blocked until a new quote and confirmation are created`,
      );
    }
  };
  await assertAmountUnchanged("before card entry");

  await requireExactConfirmation(
    [
      "SENSITIVE PAYMENT DATA",
      `The agent is ready to transmit the Altitude virtual Visa ending ${card.last4} to Wolt's card processor.`,
      `Verified checkout amount: ${amountPln.toFixed(2)} PLN.`,
      "The full PAN, expiry, and CVC will not be printed or written to output files.",
    ].join("\n"),
    `ENTER CARD ${card.last4}`,
  );

  const addCard = await visibleFirst([
    page.getByRole("button", {
      name: /add.*card|credit.*card|payment method/i,
    }),
    page.getByText(/add.*card|credit.*card/i),
  ]);
  if (addCard) {
    await addCard.click();
    await page.waitForTimeout(500);
  }
  await assertNoSaveCardPrompt(page);

  await fillAcrossFrames(
    page,
    [
      (frame) => frame.getByLabel(/card number/i),
      (frame) => frame.getByPlaceholder(/card number/i),
      (frame) => frame.locator('input[name*="cardnumber" i]'),
    ],
    card.pan,
    "card number",
  );
  await fillAcrossFrames(
    page,
    [
      (frame) => frame.getByLabel(/expir|mm.*yy/i),
      (frame) => frame.getByPlaceholder(/mm.*yy/i),
      (frame) => frame.locator('input[name*="exp" i]'),
    ],
    card.exp,
    "card expiry",
  );
  await fillAcrossFrames(
    page,
    [
      (frame) => frame.getByLabel(/cvc|cvv|security code/i),
      (frame) => frame.getByPlaceholder(/cvc|cvv/i),
      (frame) => frame.locator('input[name*="cvc" i], input[name*="cvv" i]'),
    ],
    card.cvc,
    "card CVC",
  );
  const name = await visibleFirst([
    page.getByLabel(/name on card|cardholder/i),
    page.getByPlaceholder(/name on card|cardholder/i),
  ]);
  if (name) await name.fill(card.name);

  // Some processors collect billing details in the card iframe; others use
  // the Wolt account address. Fill only fields that are visibly requested.
  await fillOptionalAcrossFrames(
    page,
    [
      (frame) =>
        frame.getByLabel(/billing address|street address|address line/i),
      (frame) =>
        frame.getByPlaceholder(/billing address|street address|address line/i),
      (frame) => frame.locator('input[name*="address" i]'),
    ],
    card.billingAddressLine,
  );
  await fillOptionalAcrossFrames(
    page,
    [
      (frame) => frame.getByLabel(/billing city|city|town/i),
      (frame) => frame.getByPlaceholder(/billing city|city|town/i),
      (frame) => frame.locator('input[name*="city" i]'),
    ],
    card.billingCity,
  );
  await fillOptionalAcrossFrames(
    page,
    [
      (frame) =>
        frame.locator('input[name*="state" i], input[name*="region" i]'),
      (frame) => frame.getByPlaceholder(/state|province|region|voivodeship/i),
    ],
    card.billingRegion,
  );
  for (const frame of page.frames()) {
    const region = frame.locator(
      'select[name*="state" i], select[name*="region" i], select[autocomplete="address-level1"]',
    );
    if (await isVisible(region)) {
      const choices = [
        { label: card.billingRegion },
        { label: "Lesser Poland Voivodeship" },
        { label: "małopolskie" },
        { label: "malopolskie" },
        { value: "12" },
      ];
      let selected = false;
      for (const choice of choices) {
        try {
          await region.first().selectOption(choice);
          selected = true;
          break;
        } catch {
          // Try the next common label/value used by Polish address forms.
        }
      }
      if (!selected) {
        throw new Error(
          "billing region was requested but Lesser Poland could not be selected",
        );
      }
      break;
    }
  }
  await fillOptionalAcrossFrames(
    page,
    [
      (frame) => frame.getByLabel(/postal|post code|zip/i),
      (frame) => frame.getByPlaceholder(/postal|post code|zip/i),
      (frame) => frame.locator('input[name*="postal" i], input[name*="zip" i]'),
    ],
    card.billingPostalCode,
  );
  for (const frame of page.frames()) {
    const country = frame.locator(
      'select[name*="country" i], select[autocomplete="country"]',
    );
    if (await isVisible(country)) {
      await country.first().selectOption(card.billingCountry);
      break;
    }
  }
  await assertNoSaveCardPrompt(page);

  await assertAmountUnchanged("immediately before Pay");

  await requireExactConfirmation(
    [
      "FINAL FINANCIAL ACTION",
      `Merchant: Wolt food delivery`,
      `City: Kraków`,
      `Amount: ${amountPln.toFixed(2)} PLN`,
      `Altitude virtual Visa: **** ${card.last4}`,
      "The next click may charge the card exactly once.",
    ].join("\n"),
    `PAY ${amountPln.toFixed(2)} ${card.last4}`,
  );
  beginSingleCardAttempt(card.last4, amountPln);
  await onAttemptStarted(card.last4);

  await clickFirst(
    [
      page.getByRole("button", {
        name: /pay|place order|confirm order|zapłać|zamawiam/i,
      }),
      page.getByText(/pay|place order|zapłać/i),
    ],
    "final Pay button",
  );
  return card.last4;
}

export async function handleThreeDs(
  page: Page,
  config: AgentConfig,
  options: RuntimeOptions,
  fallbackMerchant = "WOLT",
  onChallenge?: () => void,
): Promise<ThreeDsAudit> {
  const quote = readJson<QuoteOutput>("quote.json");
  if (quote.charge_currency === null || quote.charge_amount === null) {
    throw new Error("quote.json has no exact card charge for 3DS validation");
  }
  await page.waitForTimeout(2_500);
  const emailChoice = await visibleFirstAcrossFrames(page, [
    (frame) => frame.getByText(config.three_ds_email, { exact: false }),
    (frame) => frame.getByRole("radio", { name: /email/i }),
    (frame) => frame.getByRole("button", { name: /email/i }),
    (frame) => frame.getByText(/email/i),
  ]);
  if (emailChoice) {
    await emailChoice.click();
    const sendCode = await visibleFirstAcrossFrames(page, [
      (frame) => frame.getByRole("button", { name: /send.*code|continue/i }),
      (frame) => frame.getByText(/send.*code/i),
    ]);
    if (sendCode) await sendCode.click();
  } else {
    const frameText = (
      await Promise.all(
        page.frames().map(async (frame) => {
          try {
            return await frame.locator("body").innerText();
          } catch {
            return "";
          }
        }),
      )
    ).join("\n");
    if (
      /choose.*(?:verification|code)|verification (?:method|channel)|text message|whats ?app|send.*code.*(?:sms|phone)/i.test(
        frameText,
      )
    ) {
      throw new Error(
        "3DS offered a verification-channel choice but email was unavailable; payment fails closed",
      );
    }
  }

  const otpInput = await waitForVisibleAcrossFrames(
    page,
    [
      (frame) => frame.getByLabel(/verification code|one.time|otp/i),
      (frame) => frame.getByPlaceholder(/verification code|one.time|otp/i),
      (frame) => frame.locator('input[autocomplete="one-time-code"]'),
    ],
    10_000,
  );
  if (!otpInput) {
    return {
      provider: "none",
      mode: "frictionless",
      currency: quote.charge_currency,
      amount: quote.charge_amount,
      merchant: fallbackMerchant,
      from: null,
      completed_at: new Date().toISOString(),
    };
  }

  const attemptStartedAt = new Date();
  onChallenge?.();
  const otp = await pollForOtp(options, attemptStartedAt, config);
  console.log(`3DS message from: ${otp.from}`);
  console.log(
    `3DS payment: ${otp.currency} ${otp.amount.toFixed(2)} to ${otp.merchant}`,
  );
  console.log("3DS OTP received (not printed); bound to the active attempt.");
  if (!options.allowThreeDsSubmit) {
    console.log(
      "ALLOW_3DS_SUBMIT=false. Complete 3DS manually; the agent will not type the code.",
    );
    await requireExactConfirmation(
      "Complete 3DS manually in the visible browser or on the phone",
      "3DS COMPLETED",
    );
    await page.waitForTimeout(1_000);
    if (await isVisible(otpInput)) {
      throw new Error(
        "3DS COMPLETED was confirmed but the verification-code input is still visible",
      );
    }
    return {
      provider: "apata",
      mode: "human_completed",
      currency: otp.currency,
      amount: otp.amount,
      merchant: otp.merchant,
      from: otp.from,
      completed_at: new Date().toISOString(),
    };
  }

  await requireExactConfirmation(
    `The agent is ready to transmit the validated 3DS code (…${otp.otp.slice(-2)}) to the visible card-network 3DS page.`,
    "SUBMIT OTP",
  );
  await otpInput.fill(otp.otp);
  const verify = await visibleFirstAcrossFrames(page, [
    (frame) => frame.getByRole("button", { name: /verify|submit|continue/i }),
    (frame) => frame.getByText(/verify|submit/i),
  ]);
  if (!verify) throw new Error("could not safely locate 3DS Verify button");
  await verify.click();
  await page.waitForTimeout(1_000);
  if (await isVisible(otpInput)) {
    throw new Error("3DS verification did not leave the OTP challenge surface");
  }
  return {
    provider: "apata",
    mode: "email_otp_submitted",
    currency: otp.currency,
    amount: otp.amount,
    merchant: otp.merchant,
    from: otp.from,
    completed_at: new Date().toISOString(),
  };
}

function extractOrderId(text: string): string | null {
  const match = text.match(
    /(?:order|zamówienie)(?:\s+(?:number|id|nr))?\s*[#:]?\s*([A-Z0-9-]*\d[A-Z0-9-]{3,})/i,
  );
  return match?.[1] ?? null;
}

export async function inspectPaidPage(
  page: Page,
  amountPln: number,
): Promise<PaidOutput | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (page.isClosed()) return null;
    const text = await page.locator("body").innerText();
    if (
      /order.*(?:confirmed|received)|thanks.*order|zamówienie.*(?:przyjęte|potwierdzone)/i.test(
        text,
      )
    ) {
      const orderId = extractOrderId(text);
      if (!orderId) return null;
      await page.screenshot({
        path: screenshotPath("confirmation.png"),
        fullPage: true,
      });
      return { order_id: orderId, status: "confirmed", amount_pln: amountPln };
    }
    await page.waitForTimeout(1_000);
  }
  return null;
}

export async function humanPaymentHandoff(
  _page: Page,
  amountPln: number,
): Promise<void> {
  console.log("\nSTOPPED AT PAYMENT PAGE");
  console.log("ALLOW_PAY=false, so no card data was loaded or transmitted.");
  console.log(`Verified dry-run cart amount: ${amountPln.toFixed(2)} PLN.`);
  console.log(
    "Pay was not clicked. The browser will close after saving outputs.",
  );
}
