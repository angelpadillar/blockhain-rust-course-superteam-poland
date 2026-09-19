import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertCardAmountWithinCap,
  resolveAttachMode,
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
