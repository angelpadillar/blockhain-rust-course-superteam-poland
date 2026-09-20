import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCardAmountWithinCap,
  parseCardRows,
  parseLast4,
  parseRevealedCard,
  parseSpendableBalance,
  resolveAttachMode,
  resolveLimitFrequency,
  validateCardCommand,
} from "../src/altitude/commands.js";
import { assertAltitudeUrl } from "../src/altitude/session.js";

test("Altitude target must be an https URL", () => {
  assert.equal(
    assertAltitudeUrl("https://app.altitude.xyz"),
    "https://app.altitude.xyz",
  );
  assert.throws(
    () => assertAltitudeUrl("http://app.altitude.xyz"),
    /must be an https URL/,
  );
  assert.throws(() => assertAltitudeUrl("app.altitude.xyz"), /https URL/);
});

test("Altitude attach mode defaults based on stored credentials", () => {
  assert.equal(resolveAttachMode(undefined, true), "injected");
  assert.equal(resolveAttachMode(undefined, false), "supervised");
  assert.equal(resolveAttachMode("injected", false), "injected");
  assert.equal(resolveAttachMode("supervised", true), "supervised");
  assert.throws(
    () => resolveAttachMode("passkey", true),
    /mode must be "injected" or "supervised"/,
  );
});

test("Altitude dashboard parsers read balance and card rows", () => {
  assert.equal(
    parseSpendableBalance("Spendable balance\n$10.81\nTop up"),
    10.81,
  );
  assert.equal(parseSpendableBalance("No balance loaded"), null);
  assert.equal(parseSpendableBalance("$1,234.50"), 1234.5);

  const rows = parseCardRows(`Angel Housing
•••• 6766
Active
$10,000.00 / 7 days
Natalia
•••• 8539
Active
$10.00 / 30 days
SOL-FULFILL-DEMO-01
•••• 2027
Active
$40.00 Per authorization`);
  assert.deepEqual(rows, [
    {
      cardholder: null,
      name: "Angel Housing",
      last4: "6766",
      status: "Active",
      limit: "$10,000.00 / 7 days",
    },
    {
      cardholder: null,
      name: "Natalia",
      last4: "8539",
      status: "Active",
      limit: "$10.00 / 30 days",
    },
    {
      cardholder: null,
      name: "SOL-FULFILL-DEMO-01",
      last4: "2027",
      status: "Active",
      limit: "$40.00 Per authorization",
    },
  ]);
  assert.equal(parseLast4("•••• •••• •••• 9243"), "9243");
  assert.deepEqual(
    parseRevealedCard("4413 6965 4615 9243\n10/31\n052\nCardholder"),
    { pan: "4413 6965 4615 9243", exp: "10/31", cvv: "052" },
  );
  assert.equal(parseRevealedCard("4413 6965 4615 9243\n10/31"), null);
});

test("Altitude card settings validate frequency and reveal", () => {
  assert.equal(resolveLimitFrequency(undefined), "Per authorization");
  assert.equal(resolveLimitFrequency("7 day"), "7 day");
  assert.throws(() => resolveLimitFrequency("weekly"), /must be one of/);

  const create = validateCardCommand(
    {
      command: "create",
      reference: "order-1042",
      amount_usd: 50,
      reveal: true,
    },
    200,
  );
  assert.equal(create.reveal, true);
  assert.throws(
    () =>
      validateCardCommand(
        {
          command: "create",
          reference: "order-1042",
          amount_usd: 50,
          reveal: "yes",
        },
        200,
      ),
    /reveal is only supported/,
  );
  assert.throws(
    () =>
      validateCardCommand(
        {
          command: "freeze",
          reference: "order-1042",
          card_id: "2027",
          reveal: true,
        },
        200,
      ),
    /reveal is only supported/,
  );
});

test("card funding is capped and settles only in USDC or SOL", () => {
  assert.doesNotThrow(() => assertCardAmountWithinCap(199.99, 200));
  assert.throws(
    () => assertCardAmountWithinCap(200.01, 200),
    /exceeds ALTITUDE_MAX_CARD_USD/,
  );
  assert.throws(() => assertCardAmountWithinCap(0, 200), /missing or invalid/);

  const funded = validateCardCommand(
    {
      command: "fund",
      reference: "order-1042",
      card_id: "card_abc",
      amount_usd: 120,
      currency: "SOL",
    },
    200,
  );
  assert.equal(funded.amountUsd, 120);
  assert.equal(funded.currency, "SOL");
  assert.throws(
    () =>
      validateCardCommand(
        {
          command: "fund",
          reference: "order-1042",
          card_id: "card_abc",
          amount_usd: 120,
          currency: "USDT",
        },
        200,
      ),
    /currency must be one of USDC, SOL/,
  );
});

test("card commands require an auditable reference and a card id", () => {
  const created = validateCardCommand(
    { command: "create", reference: "order-1042", amount_usd: 50 },
    200,
  );
  assert.equal(created.currency, "USDC");
  assert.equal(created.cardId, undefined);

  assert.throws(
    () => validateCardCommand({ command: "create", amount_usd: 50 }, 200),
    /reference must be/,
  );
  assert.throws(
    () =>
      validateCardCommand({ command: "freeze", reference: "order-1042" }, 200),
    /card_id is required/,
  );
  assert.throws(
    () =>
      validateCardCommand(
        { command: "transfer", reference: "order-1042" },
        200,
      ),
    /command must be one of/,
  );
});
