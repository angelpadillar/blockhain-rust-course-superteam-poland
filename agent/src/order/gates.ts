import type { OrderRecord } from "./store.js";

export interface PayabilityContext {
  order: OrderRecord;
  /** Adapter the loaded config is running (must equal order.adapter). */
  configAdapter: string;
  /** landed_pln from the quote the executor is about to pay against. */
  quoteLandedPln: number;
  /** Spendable USD reported by the Altitude daemon balance gate. */
  spendableUsd: number;
  /** USD required to cover this order's card charge. */
  requiredUsd: number;
  /** The reusable fulfillment card's last four, for the balance-card check. */
  cardLast4: string;
  /** Whether the shared card shows Active in the manage-cards table. */
  cardActive: boolean;
  /** A card attempt marker already exists — a submission is in flight. */
  cardAttemptInFlight: boolean;
}

const IN_FLIGHT = new Set([
  "PAYMENT_SUBMITTED",
  "WAITING_FOR_3DS",
  "PAYMENT_CONFIRMED",
]);

/**
 * Every authorization gate that must pass before card details are touched.
 * Throws with a precise reason on the first failure — fail closed.
 */
export function assertOrderPayable(ctx: PayabilityContext): void {
  const { order } = ctx;
  if (order.status === "PURCHASED") {
    throw new Error(`order ${order.order_id} is already PURCHASED`);
  }
  if (IN_FLIGHT.has(order.status)) {
    throw new Error(
      `order ${order.order_id} has a payment attempt in flight (${order.status}); reconcile before retrying`,
    );
  }
  if (order.status === "PAYMENT_FAILED") {
    throw new Error(
      `order ${order.order_id} is PAYMENT_FAILED; reconcile the card attempt before any retry`,
    );
  }
  if (order.status === "REQUIRES_REAUTHORIZATION") {
    throw new Error(
      `order ${order.order_id} requires new authorization after a price change`,
    );
  }
  if (order.status === "CREATED") {
    throw new Error(
      `order ${order.order_id} is not funded; record funding before executing payment`,
    );
  }
  if (!order.funding) {
    throw new Error(`order ${order.order_id} has no recorded funding`);
  }
  if (order.funding.amount_pln < order.quoted_amount_pln - 0.005) {
    throw new Error(
      `order ${order.order_id} funding ${order.funding.amount_pln.toFixed(2)} PLN is below the quoted ${order.quoted_amount_pln.toFixed(2)} PLN`,
    );
  }
  if (order.funds_reserved_pln < order.quoted_amount_pln - 0.005) {
    throw new Error(
      `order ${order.order_id} reserved ${order.funds_reserved_pln.toFixed(2)} PLN below the quoted ${order.quoted_amount_pln.toFixed(2)} PLN`,
    );
  }
  if (order.quoted_amount_pln > order.max_authorized_amount_pln + 0.005) {
    throw new Error(
      `order ${order.order_id} quote ${order.quoted_amount_pln.toFixed(2)} PLN exceeds authorized max ${order.max_authorized_amount_pln.toFixed(2)} PLN`,
    );
  }
  if (Math.abs(ctx.quoteLandedPln - order.quoted_amount_pln) > 0.01) {
    throw new Error(
      `active quote ${ctx.quoteLandedPln.toFixed(2)} PLN does not match order ${order.order_id} authorization ${order.quoted_amount_pln.toFixed(2)} PLN; re-authorize`,
    );
  }
  if (order.adapter !== ctx.configAdapter) {
    throw new Error(
      `order ${order.order_id} is for adapter ${order.adapter}; config is ${ctx.configAdapter} — merchant/session mismatch`,
    );
  }
  if (ctx.cardAttemptInFlight) {
    throw new Error(
      "a card attempt marker already exists; one-attempt policy blocks a second submission until it is reconciled",
    );
  }
  if (!ctx.cardActive) {
    throw new Error(
      `fulfillment card ending ${ctx.cardLast4} is not Active on the Altitude manage-cards list`,
    );
  }
  if (ctx.spendableUsd < ctx.requiredUsd - 0.005) {
    throw new Error(
      `Altitude spendable balance ${ctx.spendableUsd.toFixed(2)} USD is below the required ${ctx.requiredUsd.toFixed(2)} USD`,
    );
  }
}
