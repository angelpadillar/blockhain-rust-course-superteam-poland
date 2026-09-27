import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { assertOrderPayable } from "../src/order/gates.js";
import {
  createOrder,
  listOrders,
  loadOrder,
  orderExists,
  orderPath,
  recordFunding,
  recordPurchase,
  transitionOrder,
  updateOrder,
  type OrderRecord,
} from "../src/order/store.js";
import { parseCardSecrets } from "../src/config.js";

let sequence = 0;
function testOrderId(): string {
  sequence += 1;
  return `TEST-${process.pid}-${Date.now()}-${sequence}`;
}

function cleanup(orderId: string): void {
  try {
    rmSync(orderPath(orderId));
  } catch {
    // Already removed.
  }
}

function fundedOrder(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const now = new Date().toISOString();
  return {
    order_id: "TEST-ORDER",
    adapter: "pyszne",
    merchant: "pyszne.pl",
    quoted_amount_pln: 62.5,
    max_authorized_amount_pln: 80,
    funding: {
      amount_pln: 62.5,
      reference: "sig-test",
      received_at: now,
    },
    funds_reserved_pln: 62.5,
    browser_session_id: "profile#ts",
    payment_attempt_id: null,
    status: "FUNDED",
    purchase: null,
    created_at: now,
    updated_at: now,
    history: [],
    ...overrides,
  };
}

function payableCtx(order: OrderRecord) {
  return {
    order,
    configAdapter: "pyszne",
    quoteLandedPln: order.quoted_amount_pln,
    spendableUsd: 50,
    requiredUsd: 20,
    cardLast4: "2027",
    cardActive: true,
    cardAttemptInFlight: false,
  };
}

test("order store persists and enforces the state machine", () => {
  const id = testOrderId();
  try {
    const created = createOrder({
      order_id: id,
      adapter: "pyszne",
      merchant: "pyszne.pl",
      quoted_amount_pln: 62.5,
      max_authorized_amount_pln: 80,
      browser_session_id: "profile#ts",
    });
    assert.equal(created.status, "CREATED");
    assert.equal(orderExists(id), true);
    assert.throws(
      () =>
        createOrder({
          order_id: id,
          adapter: "pyszne",
          merchant: "pyszne.pl",
          quoted_amount_pln: 62.5,
          max_authorized_amount_pln: 80,
          browser_session_id: null,
        }),
      /already exists/,
    );
    assert.throws(
      () => transitionOrder(created, "PURCHASED", "skip"),
      /cannot move from CREATED to PURCHASED/,
    );

    const funded = recordFunding(created, 62.5, "sig-abc");
    assert.equal(funded.status, "FUNDED");
    assert.equal(funded.funds_reserved_pln, 62.5);
    assert.equal(loadOrder(id).funding?.reference, "sig-abc");

    const authorized = transitionOrder(funded, "AUTHORIZED", "gates passed");
    const submitted = transitionOrder(
      authorized,
      "PAYMENT_SUBMITTED",
      "card submitted",
    );
    const waiting = transitionOrder(
      submitted,
      "WAITING_FOR_3DS",
      "challenge active",
    );
    const confirmed = transitionOrder(
      waiting,
      "PAYMENT_CONFIRMED",
      "otp verified",
    );
    const purchased = recordPurchase(confirmed, {
      merchant_order_id: "PZ-12345",
      amount_pln: 62.5,
      confirmed_at: new Date().toISOString(),
    });
    assert.equal(purchased.status, "PURCHASED");
    assert.equal(purchased.purchase?.merchant_order_id, "PZ-12345");
    assert.throws(
      () => transitionOrder(purchased, "FUNDED", "replay"),
      /cannot move from PURCHASED/,
    );
    assert.equal(loadOrder(id).status, "PURCHASED");
  } finally {
    cleanup(id);
  }
});

test("funding below the quoted amount is rejected", () => {
  const id = testOrderId();
  try {
    const created = createOrder({
      order_id: id,
      adapter: "pyszne",
      merchant: "pyszne.pl",
      quoted_amount_pln: 62.5,
      max_authorized_amount_pln: 80,
      browser_session_id: null,
    });
    assert.throws(() => recordFunding(created, 40, null), /does not cover/);
  } finally {
    cleanup(id);
  }
});

test("assertOrderPayable passes for a funded, in-policy order", () => {
  assert.doesNotThrow(() => assertOrderPayable(payableCtx(fundedOrder())));
});

test("gates fail closed on every precondition", () => {
  const cases: { name: string; mutate: (ctx: ReturnType<typeof payableCtx>) => void; pattern: RegExp }[] = [
    {
      name: "already purchased",
      mutate: (ctx) => {
        ctx.order = fundedOrder({ status: "PURCHASED" });
      },
      pattern: /already PURCHASED/,
    },
    {
      name: "attempt in flight",
      mutate: (ctx) => {
        ctx.order = fundedOrder({ status: "WAITING_FOR_3DS" });
      },
      pattern: /in flight/,
    },
    {
      name: "requires reauthorization",
      mutate: (ctx) => {
        ctx.order = fundedOrder({ status: "REQUIRES_REAUTHORIZATION" });
      },
      pattern: /new authorization/,
    },
    {
      name: "not funded",
      mutate: (ctx) => {
        ctx.order = fundedOrder({ status: "CREATED" });
      },
      pattern: /not funded/,
    },
    {
      name: "funding below quote",
      mutate: (ctx) => {
        ctx.order = fundedOrder({
          funding: {
            amount_pln: 40,
            reference: null,
            received_at: new Date().toISOString(),
          },
        });
      },
      pattern: /funding .* below/,
    },
    {
      name: "reservation below quote",
      mutate: (ctx) => {
        ctx.order = fundedOrder({ funds_reserved_pln: 10 });
      },
      pattern: /reserved .* below/,
    },
    {
      name: "quote above authorized max",
      mutate: (ctx) => {
        ctx.order = fundedOrder({
          quoted_amount_pln: 90,
          funding: {
            amount_pln: 90,
            reference: null,
            received_at: new Date().toISOString(),
          },
          funds_reserved_pln: 90,
        });
        ctx.quoteLandedPln = 90;
      },
      pattern: /exceeds authorized max/,
    },
    {
      name: "active quote drifted from authorization",
      mutate: (ctx) => {
        ctx.quoteLandedPln = 99;
      },
      pattern: /does not match order .* authorization/,
    },
    {
      name: "adapter mismatch",
      mutate: (ctx) => {
        ctx.configAdapter = "glovo";
      },
      pattern: /merchant\/session mismatch/,
    },
    {
      name: "card attempt already in flight",
      mutate: (ctx) => {
        ctx.cardAttemptInFlight = true;
      },
      pattern: /one-attempt policy/,
    },
    {
      name: "card not active",
      mutate: (ctx) => {
        ctx.cardActive = false;
      },
      pattern: /not Active/,
    },
    {
      name: "insufficient Altitude balance",
      mutate: (ctx) => {
        ctx.spendableUsd = 5;
      },
      pattern: /spendable balance .* below/,
    },
  ];
  for (const { name, mutate, pattern } of cases) {
    const ctx = payableCtx(fundedOrder());
    mutate(ctx);
    assert.throws(() => assertOrderPayable(ctx), pattern, name);
  }
});

test("updateOrder persists payment_attempt_id without a status change", () => {
  const id = testOrderId();
  try {
    const created = createOrder({
      order_id: id,
      adapter: "pyszne",
      merchant: "pyszne.pl",
      quoted_amount_pln: 30,
      max_authorized_amount_pln: 40,
      browser_session_id: null,
    });
    const updated = updateOrder(created, { payment_attempt_id: `att-${id}` });
    assert.equal(updated.status, "CREATED");
    assert.equal(loadOrder(id).payment_attempt_id, `att-${id}`);
    assert.equal(listOrders().some((o) => o.order_id === id), true);
  } finally {
    cleanup(id);
  }
});

test("parseCardSecrets validates provisioned vars identically to env", () => {
  const vars = {
    CARD_PAN: "4413696548772027",
    CARD_EXP: "05/31",
    CARD_CVC: "390",
    CARD_NAME: "Fulfillment Demo",
    CARD_BILLING_ADDRESS_LINE: "45 Rzącka",
    CARD_BILLING_CITY: "Kraków",
    CARD_BILLING_REGION: "Lesser Poland Voivodeship",
    CARD_BILLING_POSTAL_CODE: "30-687",
    CARD_BILLING_COUNTRY: "PL",
  };
  const options = { cardRail: "altitude" } as Parameters<
    typeof parseCardSecrets
  >[1];
  const secrets = parseCardSecrets(vars, options);
  assert.equal(secrets.last4, "2027");
  assert.equal(secrets.billingCity, "Kraków");
  assert.throws(
    () => parseCardSecrets({ ...vars, CARD_CVC: "12" }, options),
    /CARD_CVC/,
  );
});
