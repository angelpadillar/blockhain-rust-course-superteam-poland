import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderNote, specHash, validateConfig } from "../src/config.js";
import {
  classifyMail,
  parsePaymentThreeDs,
  validatePaymentThreeDs,
} from "../src/otp.js";
import { agentRoot } from "../src/paths.js";
import {
  assertAmountWithinCap,
  assertCardAttemptCanArchive,
  assertSecretPathsIgnored,
  cardAttemptAuthPending,
  cardAttemptReconciledNoCharge,
} from "../src/policy.js";
import {
  buildQuote,
  parseCheckoutBreakdown,
  parseCheckoutTotal,
} from "../src/quote.js";
import {
  parseAgentMailPaymentMessage,
  parsePyszneLoginChallenge,
  parseWoltLoginLink,
} from "../src/agentmail.js";
import { buildPaymentAuthArtifact } from "../src/chain.js";
import { validateMcpBrowserObservation } from "../src/mcp-observation.js";
import {
  parseRemainingMinimumOrder,
  submitPyszneEmailLogin,
} from "../src/adapter/browser_food.js";
import { isAllowedPysznePaymentUrl } from "../src/pyszne-payment-policy.js";
import { assertSaveCardDisabled } from "../src/save-card-policy.js";

test("max_pln aborts above the configured cap", () => {
  assert.doesNotThrow(() => assertAmountWithinCap(79.99, 80));
  assert.throws(() => assertAmountWithinCap(80.01, 80), /exceeds max_pln/);
});

test("3DS browser loss stays auth_pending until a human reconciles no charge", () => {
  const started = {
    status: "started" as const,
    last4: "2027",
    amount_pln: 62.53,
    started_at: "2026-08-30T09:48:04.792Z",
  };
  const pending = cardAttemptAuthPending(
    started,
    "awaiting validated OTP",
    new Date("2026-08-30T09:50:00.000Z"),
  );
  assert.equal(pending.status, "auth_pending");
  assert.equal(pending.last4, "2027");
  assert.throws(() => assertCardAttemptCanArchive(pending), /unresolved/);
  const reconciled = cardAttemptReconciledNoCharge(
    pending,
    "human confirmed no charge",
    new Date("2026-08-30T10:00:00.000Z"),
  );
  assert.equal(reconciled.status, "reconciled_no_charge");
  assert.doesNotThrow(() => assertCardAttemptCanArchive(reconciled));
});

test("secret-bearing agent paths are gitignored", () => {
  assert.doesNotThrow(() => assertSecretPathsIgnored());
});

test("payment and 3DS submission remain disabled in the example environment", () => {
  const example = readFileSync(`${agentRoot}/.env.example`, "utf8");
  assert.match(example, /^ALLOW_PAY=false$/m);
  assert.match(example, /^ALLOW_3DS_SUBMIT=false$/m);
  assert.match(example, /^ALLOW_SAVE_CARD=false$/m);
  assert.doesNotMatch(example, /^ALLOW_PAY=true$/m);
  assert.doesNotMatch(example, /^ALLOW_3DS_SUBMIT=true$/m);
  assert.doesNotMatch(example, /^ALLOW_SAVE_CARD=true$/m);
  assert.match(example, /^CARD_PAN=$/m);
  assert.match(example, /^CARD_EXP=$/m);
  assert.match(example, /^CARD_CVC=$/m);
  assert.match(example, /^AGENTMAIL_API_KEY=$/m);
});

test("an optional unchecked save-card checkbox is safe but checked or unverifiable storage fails closed", () => {
  assert.doesNotThrow(() =>
    assertSaveCardDisabled({
      promptVisible: true,
      controlVisible: true,
      checked: false,
    }),
  );
  assert.throws(
    () =>
      assertSaveCardDisabled({
        promptVisible: true,
        controlVisible: true,
        checked: true,
      }),
    /storage is enabled/,
  );
  assert.throws(
    () =>
      assertSaveCardDisabled({
        promptVisible: true,
        controlVisible: false,
        checked: null,
      }),
    /could not be verified/,
  );
});

test("delivery note is exact and renders an explicit nonce", () => {
  assert.equal(renderNote("Solana PoC — reception"), "Solana PoC — reception");
  assert.equal(
    renderNote("Solana PoC {nonce} — reception / Superteam", "demo_42"),
    "Solana PoC demo_42 — reception / Superteam",
  );
  assert.throws(() => renderNote("Solana PoC {nonce}"), /FULFILLMENT_NONCE/);
});

test("mail classifier distinguishes Apata payment 3DS from Altitude login OTP", () => {
  const apata = readFileSync(`${agentRoot}/fixtures/apata-3ds.txt`, "utf8");
  const login = readFileSync(
    `${agentRoot}/fixtures/altitude-login-otp.txt`,
    "utf8",
  );
  assert.equal(classifyMail(apata), "payment_3ds");
  assert.equal(classifyMail(login), "altitude_login_otp");
  assert.equal(
    classifyMail("From: stranger@example.invalid\nCode 123456"),
    "unknown",
  );
});

test("Apata parser extracts provider, amount, merchant, and exact 6-digit OTP", () => {
  const fixture = readFileSync(`${agentRoot}/fixtures/apata-3ds.txt`, "utf8");
  assert.deepEqual(parsePaymentThreeDs(fixture), {
    kind: "payment_3ds",
    provider: "apata",
    currency: "EUR",
    amount: 24.9,
    merchant: "WOLT",
    otp: "123456",
    from: "no-reply@apata.io",
  });
});

test("Apata parser accepts a three-letter currency and its quoted exponent", () => {
  const parsed = parsePaymentThreeDs(
    [
      "From: no-reply@apata.io",
      "Please confirm your payment of KWD 12.345 to WOLT using the code 123456",
    ].join("\n"),
  );
  assert.equal(parsed.currency, "KWD");
  assert.equal(parsed.amount, 12.345);
});

test("Altitude login OTP is never parsed as payment 3DS", () => {
  const fixture = readFileSync(
    `${agentRoot}/fixtures/altitude-login-otp.txt`,
    "utf8",
  );
  assert.throws(
    () => parsePaymentThreeDs(fixture),
    /must never be submitted as payment 3DS/,
  );
});

test("AgentMail adapter parses only fresh payment mail from approved senders", () => {
  const apata = readFileSync(`${agentRoot}/fixtures/apata-3ds.txt`, "utf8");
  const body = apata.replace(/^From:.*$/im, "").trim();
  const timestamp = new Date("2026-08-29T12:00:00.000Z");
  const parsed = parseAgentMailPaymentMessage(
    {
      from: "Apata <no-reply@apata.io>",
      subject: "One Time Passcode",
      text: body,
      timestamp,
    },
    new Date("2026-08-29T11:59:55.000Z"),
  );
  assert.equal(parsed?.kind, "payment_3ds");
  assert.equal(parsed?.provider, "apata");
  assert.equal(parsed?.otp, "123456");
  assert.equal(parsed?.ts, timestamp.toISOString());
  assert.equal(
    parseAgentMailPaymentMessage(
      {
        from: "no-reply@apata.io",
        subject: "One Time Passcode",
        text: body,
        timestamp,
      },
      new Date("2026-08-29T12:00:01.000Z"),
    ),
    null,
  );
  assert.equal(
    parseAgentMailPaymentMessage(
      {
        from: "orders@example.invalid",
        subject: "Order update",
        text: "No OTP",
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    null,
  );
});

test("AgentMail adapter rejects Altitude login mail", () => {
  const login = readFileSync(
    `${agentRoot}/fixtures/altitude-login-otp.txt`,
    "utf8",
  );
  const body = login.replace(/^From:.*$/im, "").trim();
  assert.throws(
    () =>
      parseAgentMailPaymentMessage(
        {
          from: "notifications@altitude.squads.xyz",
          subject: "Continue in Altitude",
          text: body,
          timestamp: new Date("2026-08-29T12:00:00.000Z"),
        },
        new Date("2026-08-29T11:59:55.000Z"),
      ),
    /never valid for payment 3DS/,
  );
});

test("AgentMail Wolt login parser accepts only fresh wolt.com HTTPS links", () => {
  const fixture = readFileSync(
    `${agentRoot}/fixtures/wolt-login-link.txt`,
    "utf8",
  );
  const timestamp = new Date("2026-08-29T12:00:00.000Z");
  assert.equal(
    parseWoltLoginLink(
      {
        from: "Wolt <login@emails.wolt.com>",
        subject: "Log in to Wolt",
        text: fixture,
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    "https://wolt.com/en/login?token=synthetic-demo-token",
  );
  assert.equal(
    parseWoltLoginLink(
      {
        from: "Wolt <login@emails.wolt.com>",
        subject: "Welcome to Wolt",
        text: "https://wolt.com/me/magic_login?token=synthetic-welcome-token",
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    "https://wolt.com/me/magic_login?token=synthetic-welcome-token",
  );
  assert.equal(
    parseWoltLoginLink(
      {
        from: "attacker@example.invalid",
        subject: "Log in to Wolt",
        text: fixture,
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    null,
  );
  assert.throws(
    () =>
      parseWoltLoginLink(
        {
          from: "login@emails.wolt.com",
          subject: "Log in to Wolt",
          text: "https://example.invalid/not-wolt",
          timestamp,
        },
        new Date("2026-08-29T11:59:55.000Z"),
      ),
    /did not contain an HTTPS link on a wolt.com host/,
  );
});

test("AgentMail Pyszne login parser accepts only fresh allowlisted challenges", () => {
  const fixture = readFileSync(
    `${agentRoot}/fixtures/pyszne-login.txt`,
    "utf8",
  );
  const timestamp = new Date("2026-08-29T12:00:00.000Z");
  assert.deepEqual(
    parsePyszneLoginChallenge(
      {
        from: "Pyszne.pl <no-reply@pyszne.pl>",
        subject: "Log in to Pyszne.pl",
        text: fixture,
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    {
      kind: "link",
      link: "https://auth.pyszne.pl/account/email-login?token=synthetic-demo-token",
    },
  );
  assert.deepEqual(
    parsePyszneLoginChallenge(
      {
        from: "Just Eat <no-reply@takeaway.com>",
        subject: "Your Pyszne verification code",
        text: "Enter this code to log in: AB1CD2",
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    { kind: "otp", otp: "AB1CD2" },
  );
  assert.deepEqual(
    parsePyszneLoginChallenge(
      {
        from: "Pyszne <no-reply@pyszne.pl>",
        subject: "Twój kod weryfikacyjny",
        text: "Wpisz kod, aby się zalogować: ZX8QW2",
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    { kind: "otp", otp: "ZX8QW2" },
  );
  assert.equal(
    parsePyszneLoginChallenge(
      {
        from: "attacker@example.invalid",
        subject: "Log in to Pyszne.pl",
        text: fixture,
        timestamp,
      },
      new Date("2026-08-29T11:59:55.000Z"),
    ),
    null,
  );
});

test("checkout parser accepts labelled Polish totals and rejects unlabeled prices", () => {
  assert.equal(
    parseCheckoutTotal("Subtotal\n55,00 zł\nTotal\n72,49 zł"),
    72.49,
  );
  assert.equal(parseCheckoutTotal("Suma PLN 80.00"), 80);
  assert.equal(parseCheckoutTotal("Razem\n44,99 zł"), 44.99);
  assert.throws(
    () => parseCheckoutTotal("Sernik 18,00 zł"),
    /could not identify/,
  );
});

test("Glovo and Pyszne configs retain the food allowlist and Kraków guard", () => {
  const base = {
    job_kind: "food",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Zabłocie 20, 30-701 Kraków",
    recipient_name: "Fulfillment Demo",
    phone: "+13522997668",
    contact_email: "fulfillment-demo@mail.buena.ai",
    three_ds_email: "fulfillment-demo@mail.buena.ai",
    items: [{ query: "sernik", qty: 1 }],
    note: "Solana PoC — reception / Superteam",
    max_pln: 80,
    constraints: ["office-safe"],
  };
  assert.equal(validateConfig({ ...base, adapter: "glovo" }).adapter, "glovo");
  assert.equal(
    validateConfig({ ...base, adapter: "pyszne" }).adapter,
    "pyszne",
  );
  assert.throws(
    () =>
      validateConfig({
        ...base,
        adapter: "pyszne",
        items: [{ query: "wine", qty: 1 }],
      }),
    /not an allowed food\/grocery/,
  );
  assert.throws(
    () => validateConfig({ ...base, adapter: "glovo", city: "Warszawa" }),
    /must be Kraków/,
  );
  assert.doesNotThrow(() =>
    validateConfig({
      ...base,
      adapter: "glovo",
      items: [
        {
          query:
            "Hortex Tropical Duo Napój wieloowocowy czerwone winogrono gujawa 1 L",
          qty: 1,
        },
      ],
    }),
  );
});

test("Pyszne minimum-order message fails closed until the threshold is met", () => {
  assert.equal(
    parseRemainingMinimumOrder("Spend another 41,00 zł for delivery"),
    41,
  );
  assert.equal(
    parseRemainingMinimumOrder("Subtotal 41,80 zł\nTotal 46,08 zł"),
    null,
  );
});

test("Pyszne card entry accepts only HTTPS Pyszne and official PayU hosts", () => {
  assert.equal(
    isAllowedPysznePaymentUrl("https://www.pyszne.pl/en/checkout"),
    true,
  );
  assert.equal(
    isAllowedPysznePaymentUrl("https://secure.payu.com/card/checkout"),
    true,
  );
  assert.equal(
    isAllowedPysznePaymentUrl("https://secure.payu.pl/card/checkout"),
    true,
  );
  assert.equal(
    isAllowedPysznePaymentUrl("http://secure.payu.com/card/checkout"),
    false,
  );
  assert.equal(
    isAllowedPysznePaymentUrl("https://payu.com.attacker.invalid/card"),
    false,
  );
});

test("Pyszne email login submits from the email field without provider buttons", async () => {
  const actions: string[] = [];
  await submitPyszneEmailLogin(
    {
      fill: async (value: string) => {
        actions.push(`fill:${value}`);
      },
      press: async (key: string) => {
        actions.push(`press:${key}`);
      },
    },
    "fulfillment-demo@mail.buena.ai",
  );
  assert.deepEqual(actions, [
    "fill:fulfillment-demo@mail.buena.ai",
    "press:Enter",
  ]);
});

test("MCP visual quote validates Pyszne items, fees, destination, and cap", () => {
  const config = validateConfig({
    job_kind: "food",
    adapter: "pyszne",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Zabłocie 20, 30-701 Kraków",
    recipient_name: "Fulfillment Demo",
    phone: "+13522997668",
    contact_email: "fulfillment-demo@mail.buena.ai",
    items: [
      { query: "Viennese Cheesecake", qty: 1 },
      { query: "Chocolate Nut Croissant", qty: 1 },
    ],
    note: "Solana PoC — reception / Superteam",
    max_pln: 80,
  });
  const captured = new Date("2026-08-29T16:13:54.000Z");
  const observed = {
    extracted_by: "mcp_visual" as const,
    job_kind: "food" as const,
    adapter: "pyszne" as const,
    city: "Kraków" as const,
    merchant: "Krakowskie Wypieki",
    items: [
      {
        approved_query: "Viennese Cheesecake",
        visible_item: "Viennese Cheesecake",
        quantity: 1,
      },
      {
        approved_query: "Chocolate Nut Croissant",
        visible_item: "Chocolate Nut Croissant",
        quantity: 1,
      },
    ],
    address_street: "Zabłocie 20",
    recipient_name: "Fulfillment Demo",
    note: config.note,
    destination_confirmed_at_quote: true as const,
    delivery_option: "standard" as const,
    checkout_stage: "final_summary_before_payment_method" as const,
    item_subtotal_pln: 41.8,
    small_order_fee_pln: 0,
    service_fee_pln: 2.29,
    delivery_fee_pln: 1.99,
    tip_pln: 0,
    other_fees_pln: 0,
    landed_pln: 46.08,
    source_url: "https://www.pyszne.pl/en/checkout?basket=synthetic",
    payment_method_opened: false as const,
    captured_at: captured.toISOString(),
  };
  const quote = validateMcpBrowserObservation(
    config,
    config.note,
    observed,
    new Date(captured.valueOf() - 1_000),
  );
  assert.equal(quote.landed_pln, 46.08);
  assert.deepEqual(quote.breakdown_pln, {
    item_subtotal: 41.8,
    small_order_fee: 0,
    service_fee: 2.29,
    delivery_fee: 1.99,
    tip: 0,
    other_fees: 0,
  });
  assert.throws(
    () =>
      validateMcpBrowserObservation(
        config,
        config.note,
        { ...observed, service_fee_pln: 3.99 },
        new Date(captured.valueOf() - 1_000),
      ),
    /does not equal components/,
  );
});

test("milk demo policy accepts only regular 1 L cow's milk at exactly 3.2%", () => {
  const config = validateConfig({
    job_kind: "food",
    adapter: "pyszne",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Zabłocie 20, 30-701 Kraków",
    recipient_name: "Fulfillment Demo",
    phone: "+13522997668",
    contact_email: "fulfillment-demo@mail.buena.ai",
    items: [{ query: "mleko", qty: 2 }],
    note: "Solana PoC — reception / Superteam",
    max_pln: 70,
    constraints: ["no-substitutions", "regular-cow-milk-1l-3.2-percent"],
  });
  const captured = new Date();
  const observed = {
    extracted_by: "mcp_visual" as const,
    job_kind: "food" as const,
    adapter: "pyszne" as const,
    city: "Kraków" as const,
    merchant: "Demo Grocery",
    items: [
      {
        approved_query: "mleko",
        visible_item: "Łaciate mleko UHT 3,2% 1 l",
        quantity: 2,
      },
    ],
    address_street: "Zabłocie 20",
    recipient_name: "Fulfillment Demo",
    note: config.note,
    destination_confirmed_at_quote: true as const,
    delivery_option: "standard" as const,
    checkout_stage: "final_summary_before_payment_method" as const,
    item_subtotal_pln: 9.98,
    small_order_fee_pln: 20,
    service_fee_pln: 1.5,
    delivery_fee_pln: 4.99,
    tip_pln: 0,
    other_fees_pln: 0,
    landed_pln: 36.47,
    source_url: "https://www.pyszne.pl/en/checkout?basket=synthetic-milk",
    payment_method_opened: false as const,
    captured_at: captured.toISOString(),
  };
  assert.equal(
    validateMcpBrowserObservation(
      config,
      config.note,
      observed,
      new Date(captured.valueOf() - 1_000),
    ).landed_pln,
    36.47,
  );
  assert.throws(
    () =>
      validateMcpBrowserObservation(
        config,
        config.note,
        {
          ...observed,
          items: [
            {
              approved_query: "mleko",
              visible_item: "Łaciate mleko bez laktozy 3,2% 1 l",
              quantity: 2,
            },
          ],
        },
        new Date(captured.valueOf() - 1_000),
      ),
    /not unflavoured regular cow's milk/,
  );
  assert.throws(
    () =>
      validateMcpBrowserObservation(
        config,
        config.note,
        {
          ...observed,
          items: [
            {
              approved_query: "mleko",
              visible_item: "Łaciate mleko UHT 2% 1 l",
              quantity: 2,
            },
          ],
        },
        new Date(captured.valueOf() - 1_000),
      ),
    /not exactly 3.2% fat/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        constraints: ["no-substitutions"],
      }),
    /milk orders require/,
  );
});

test("milk minimum-order top-ups are explicit without applying milk rules to snacks", () => {
  const items = [
    { query: "Łaciate UHT Milk 3.2% 1L", qty: 2 },
    {
      query: "Coconut vitamin baton coated in milk chocolate 50 g",
      qty: 2,
    },
    { query: "Mars bar 51 g", qty: 3 },
    { query: "Twix bar 50 g", qty: 3 },
  ];
  const config = validateConfig({
    job_kind: "food",
    adapter: "pyszne",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Zabłocie 20, 30-701 Kraków",
    recipient_name: "Fulfillment Demo",
    phone: "+13522997668",
    contact_email: "fulfillment-demo@mail.buena.ai",
    items,
    note: "Solana PoC — reception / Superteam",
    max_pln: 70,
    constraints: ["no-substitutions", "regular-cow-milk-1l-3.2-percent"],
  });
  const captured = new Date();
  const quote = validateMcpBrowserObservation(
    config,
    config.note,
    {
      extracted_by: "mcp_visual",
      job_kind: "food",
      adapter: "pyszne",
      city: "Kraków",
      merchant: "Sklep Blumiś Ciesielskiego",
      items: items.map((item) => ({
        approved_query: item.query,
        visible_item: item.query,
        quantity: item.qty,
      })),
      address_street: "Zabłocie 20",
      recipient_name: "Fulfillment Demo",
      note: config.note,
      destination_confirmed_at_quote: true,
      delivery_option: "standard",
      checkout_stage: "final_summary_before_payment_method",
      item_subtotal_pln: 45,
      small_order_fee_pln: 0,
      service_fee_pln: 2.47,
      delivery_fee_pln: 12.99,
      tip_pln: 0,
      other_fees_pln: 0,
      landed_pln: 60.46,
      source_url: "https://www.pyszne.pl/en/checkout?basket=synthetic-milk",
      payment_method_opened: false,
      captured_at: captured.toISOString(),
    },
    new Date(captured.valueOf() - 1_000),
  );
  assert.equal(quote.landed_pln, 60.46);
});

test("agent-curated grocery mode binds the exact live basket and rejects unsafe substitutes", () => {
  const config = validateConfig({
    job_kind: "food",
    adapter: "pyszne",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Zabłocie 20, 30-701 Kraków",
    recipient_name: "Fulfillment Demo",
    phone: "+13522997668",
    contact_email: "fulfillment-demo@mail.buena.ai",
    selection: {
      mode: "agent_curated",
      participants: 9,
      milk_liters: 2,
      milk_fat_percent: 3.2,
      beverage_servings_min: 9,
      allow_100_percent_juice: true,
      allow_office_safe_functional_drinks: true,
      include_healthy_snacks: true,
    },
    items: [],
    note: "Solana PoC — reception / Superteam",
    max_pln: 70,
    constraints: [
      "office-safe",
      "no-substitutions",
      "regular-cow-milk-1l-3.2-percent",
      "agent-curated",
      "no-nectar-or-juice-drinks",
    ],
  });
  const captured = new Date();
  const base = {
    extracted_by: "mcp_visual" as const,
    job_kind: "food" as const,
    adapter: "pyszne" as const,
    city: "Kraków" as const,
    merchant: "Lisek .app",
    items: [
      {
        approved_query: "agent-curated milk",
        visible_item: "Mlekovita UHT Milk 3.2% 1L x2",
        quantity: 1,
      },
      {
        approved_query: "agent-curated beverage",
        visible_item: "Apple Juice 100% 1L",
        quantity: 3,
      },
      {
        approved_query: "agent-curated snack",
        visible_item: "Bananas 6 pcs",
        quantity: 1,
      },
    ],
    address_street: "Zabłocie 20",
    recipient_name: "Fulfillment Demo",
    note: config.note,
    destination_confirmed_at_quote: true as const,
    delivery_option: "standard" as const,
    checkout_stage: "final_summary_before_payment_method" as const,
    item_subtotal_pln: 50,
    small_order_fee_pln: 0,
    service_fee_pln: 2.25,
    delivery_fee_pln: 7.99,
    tip_pln: 0,
    other_fees_pln: 1.99,
    landed_pln: 62.23,
    source_url: "https://www.pyszne.pl/en/checkout?basket=curated",
    payment_method_opened: false as const,
    captured_at: captured.toISOString(),
  };
  const quote = validateMcpBrowserObservation(
    config,
    config.note,
    base,
    new Date(captured.valueOf() - 1_000),
  );
  const changed = validateMcpBrowserObservation(
    config,
    config.note,
    {
      ...base,
      items: base.items.map((item, index) =>
        index === 2
          ? { ...item, visible_item: "Wholegrain rice cakes 130 g" }
          : item,
      ),
    },
    new Date(captured.valueOf() - 1_000),
  );
  assert.notEqual(quote.spec_hash, changed.spec_hash);
  assert.throws(
    () =>
      validateMcpBrowserObservation(
        config,
        config.note,
        {
          ...base,
          items: base.items.map((item, index) =>
            index === 1 ? { ...item, visible_item: "Apple nectar 1L" } : item,
          ),
        },
        new Date(captured.valueOf() - 1_000),
      ),
    /not approved milk, beverage, or healthy snack/,
  );
  assert.throws(
    () =>
      validateMcpBrowserObservation(
        config,
        config.note,
        {
          ...base,
          items: base.items.map((item, index) =>
            index === 2
              ? { ...item, visible_item: "Chocolate bar 50 g" }
              : item,
          ),
        },
        new Date(captured.valueOf() - 1_000),
      ),
    /not approved milk, beverage, or healthy snack/,
  );
});

test("checkout quote preserves the final landed fee breakdown", () => {
  assert.deepEqual(
    parseCheckoutBreakdown(
      [
        "Subtotal 20,50 zł",
        "Small order fee 4,99 zł",
        "Service fee 3,90 zł",
        "Delivery fee 2,25 zł",
        "Total 31,64 zł",
      ].join("\n"),
      31.64,
    ),
    {
      item_subtotal: 20.5,
      small_order_fee: 4.99,
      service_fee: 3.9,
      delivery_fee: 2.25,
      tip: 0,
      other_fees: 0,
    },
  );
  assert.deepEqual(
    parseCheckoutBreakdown(
      [
        "Products 41,80 zł",
        "Delivery 1,99 zł",
        "Service fee 5,5% (max 3,99 zł) 2,29 zł",
        "Total 46,08 zł",
      ].join("\n"),
      46.08,
    ),
    {
      item_subtotal: 41.8,
      small_order_fee: 0,
      service_fee: 2.29,
      delivery_fee: 1.99,
      tip: 0,
      other_fees: 0,
    },
  );
});

test("Wolt config rejects a destination outside Kraków and non-food queries", () => {
  const base = {
    job_kind: "food",
    adapter: "wolt",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Rynek 1, Kraków",
    latlon_hint: null,
    recipient_name: "Demo Contact",
    phone: "+48123123123",
    contact_email: "angel@buena.ai",
    three_ds_email: "fulfillment-demo@mail.buena.ai",
    items: [{ query: "sernik", qty: 1 }],
    note: "Solana PoC — reception",
    max_pln: 80,
    constraints: ["office-safe"],
    prefer_3ds_channel: "email",
  };
  assert.equal(validateConfig(base).city, "Kraków");
  assert.equal(
    validateConfig(base).three_ds_email,
    "fulfillment-demo@mail.buena.ai",
  );
  assert.throws(
    () => validateConfig({ ...base, city: "Warszawa" }),
    /must be Kraków/,
  );
  assert.throws(
    () => validateConfig({ ...base, items: [{ query: "wine", qty: 1 }] }),
    /not an allowed food\/grocery/,
  );
});

test("payment 3DS rejects an amount that does not match the explicit quote", () => {
  const config = validateConfig({
    job_kind: "food",
    adapter: "wolt",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Rynek 1, Kraków",
    recipient_name: "Demo Contact",
    phone: "+48123123123",
    contact_email: "angel@buena.ai",
    merchant_descriptor: "WOLT KRAKOW",
    items: [{ query: "sernik", qty: 1 }],
    note: "Solana PoC — reception",
    max_pln: 80,
    constraints: ["office-safe"],
  });
  const quote = {
    ...buildQuote(
      config,
      config.note,
      74.7,
      "https://example.invalid/quote",
      "same-day",
    ),
    charge_currency: "EUR" as const,
    charge_amount: 24.9,
    settlement_units_per_charge_unit: 3,
    pln_per_charge_unit: 3,
  };
  const parsed = parsePaymentThreeDs(
    readFileSync(`${agentRoot}/fixtures/apata-3ds.txt`, "utf8"),
  );
  const handoff = {
    ...parsed,
    ts: "2026-08-29T12:00:00.000Z",
  };
  assert.equal(
    validatePaymentThreeDs(
      handoff,
      config,
      quote,
      new Date("2026-08-29T11:59:00.000Z"),
    ).otp,
    "123456",
  );
  assert.throws(
    () =>
      validatePaymentThreeDs(
        { ...handoff, amount: 25.5 },
        config,
        quote,
        new Date("2026-08-29T11:59:00.000Z"),
      ),
    /does not match quoted charge/,
  );
});

test("Glovo payment 3DS accepts only known Glovo merchant descriptors", () => {
  const config = validateConfig({
    job_kind: "food",
    adapter: "glovo",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Zabłocie 20, 30-701 Kraków",
    recipient_name: "Fulfillment Demo",
    phone: "+13522997668",
    contact_email: "fulfillment-demo@mail.buena.ai",
    three_ds_email: "fulfillment-demo@mail.buena.ai",
    merchant_descriptor: "GLOVO",
    items: [{ query: "sok jabłko 1 l", qty: 1 }],
    note: "Solana PoC — reception / Superteam",
    max_pln: 25,
    constraints: ["office-safe", "non-alcoholic-only"],
  });
  const quote = buildQuote(
    config,
    config.note,
    24.5,
    "https://glovoapp.com/en/pl/krakow/checkout",
    "same-day",
  );
  const handoff = {
    kind: "payment_3ds" as const,
    provider: "apata" as const,
    currency: "PLN",
    amount: 24.5,
    merchant: "GLOVOAPP",
    otp: "654321",
    from: "no-reply@apata.io",
    ts: "2026-08-30T12:00:00.000Z",
  };
  assert.equal(
    validatePaymentThreeDs(
      handoff,
      config,
      quote,
      new Date("2026-08-30T11:59:00.000Z"),
    ).merchant,
    "GLOVOAPP",
  );
  assert.throws(
    () =>
      validatePaymentThreeDs(
        { ...handoff, merchant: "UNRELATED SHOP" },
        config,
        quote,
        new Date("2026-08-30T11:59:00.000Z"),
      ),
    /not in the configured allowlist/,
  );
});

test("redacted on-chain authentication artifact omits OTP and uses exact minor units", () => {
  const config = validateConfig({
    job_kind: "food",
    adapter: "wolt",
    city: "Kraków",
    venue_label: "Superteam demo venue",
    destination_type: "venue",
    address_line: "Rynek 1, Kraków",
    recipient_name: "Demo Contact",
    phone: "+48123123123",
    contact_email: "angel@buena.ai",
    items: [{ query: "sernik", qty: 1 }],
    note: "Solana PoC — reception",
    max_pln: 80,
    constraints: ["office-safe"],
  });
  const quote = {
    ...buildQuote(config, config.note, 63.53, null, "same-day"),
    charge_currency: "KWD",
    charge_currency_exponent: 3,
    charge_amount: 12.345,
    settlement_units_per_charge_unit: 5.146,
    pln_per_charge_unit: 5.146,
  };
  const artifact = buildPaymentAuthArtifact(quote, {
    provider: "apata",
    mode: "email_otp_submitted",
    currency: "KWD",
    amount: 12.345,
    merchant: "WOLT",
    from: "no-reply@apata.io",
    completed_at: "2026-08-29T12:00:00.000Z",
  });
  assert.equal(artifact.amount_minor, 12_345);
  assert.equal("otp" in artifact, false);
  assert.doesNotMatch(JSON.stringify(artifact), /123456/);
});

test("local-print config accepts same-day Kraków merch and hashes its spec", () => {
  const config = validateConfig({
    job_kind: "merch",
    adapter: "local_print",
    city: "Kraków",
    venue_label: "Demo venue",
    address_line: "Rynek 1, Kraków",
    recipient_name: "Demo Contact",
    contact_email: "angel@buena.ai",
    spec: {
      item: "one printed tote",
      design_file: null,
      text_fallback: "Buena × Solana PoC",
      qty: 1,
      note: "Solana PoC — reception",
    },
    max_pln: 150,
    constraints: [
      "office-safe",
      "venue-delivery-or-pickup",
      "same-day-or-fail",
    ],
  });
  assert.equal(config.adapter, "local_print");
  assert.match(specHash(config), /^[a-f0-9]{64}$/);
  const quote = buildQuote(
    config,
    config.note,
    99,
    "https://example.invalid/quote",
    "same-day",
  );
  assert.deepEqual(
    {
      job_kind: quote.job_kind,
      adapter: quote.adapter,
      landed_pln: quote.landed_pln,
      max_pln: quote.max_pln,
      note: quote.note,
      spec_hash: quote.spec_hash,
      venue_label: quote.venue_label,
      sla: quote.sla,
    },
    {
      job_kind: "merch",
      adapter: "local_print",
      landed_pln: 99,
      max_pln: 150,
      note: "Solana PoC — reception",
      spec_hash: specHash(config),
      venue_label: "Demo venue",
      sla: "same-day",
    },
  );
});

test("local-print policy rejects overseas factories and missing same-day constraint", () => {
  const base = {
    job_kind: "merch",
    adapter: "local_print",
    city: "Kraków",
    venue_label: "Demo venue",
    address_line: "Rynek 1, Kraków",
    recipient_name: "Demo Contact",
    contact_email: "angel@buena.ai",
    spec: {
      item: "printed sticker",
      design_file: null,
      text_fallback: "Buena × Solana PoC",
      qty: 1,
      note: "Solana PoC — reception",
    },
    max_pln: 150,
    constraints: ["office-safe", "same-day-or-fail"],
  };
  assert.throws(
    () => validateConfig({ ...base, constraints: ["office-safe"] }),
    /same-day-or-fail/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...base,
        constraints: [...base.constraints, "Printful"],
      }),
    /overseas factory or multi-week/,
  );
});
