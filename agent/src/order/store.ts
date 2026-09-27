import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ordersDir } from "../paths.js";

export type OrderStatus =
  | "CREATED"
  | "FUNDED"
  | "AUTHORIZED"
  | "PAYMENT_SUBMITTED"
  | "WAITING_FOR_3DS"
  | "PAYMENT_CONFIRMED"
  | "PURCHASED"
  | "PAYMENT_FAILED"
  | "REQUIRES_REAUTHORIZATION";

export interface OrderFunding {
  amount_pln: number;
  reference: string | null;
  received_at: string;
}

export interface OrderPurchase {
  merchant_order_id: string;
  amount_pln: number;
  confirmed_at: string;
  payment_attempt_id: string;
}

export interface OrderEvent {
  status: OrderStatus;
  at: string;
  detail: string;
}

export interface OrderRecord {
  order_id: string;
  adapter: string;
  merchant: string;
  quoted_amount_pln: number;
  max_authorized_amount_pln: number;
  funding: OrderFunding | null;
  funds_reserved_pln: number;
  browser_session_id: string | null;
  payment_attempt_id: string | null;
  status: OrderStatus;
  purchase: OrderPurchase | null;
  created_at: string;
  updated_at: string;
  history: OrderEvent[];
}

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ["FUNDED", "PAYMENT_FAILED"],
  FUNDED: ["AUTHORIZED", "PAYMENT_FAILED"],
  AUTHORIZED: ["PAYMENT_SUBMITTED", "PAYMENT_FAILED", "REQUIRES_REAUTHORIZATION"],
  PAYMENT_SUBMITTED: [
    "WAITING_FOR_3DS",
    "PAYMENT_CONFIRMED",
    "PAYMENT_FAILED",
    "REQUIRES_REAUTHORIZATION",
  ],
  WAITING_FOR_3DS: ["PAYMENT_CONFIRMED", "PAYMENT_FAILED"],
  PAYMENT_CONFIRMED: ["PURCHASED", "PAYMENT_FAILED"],
  PURCHASED: [],
  PAYMENT_FAILED: ["FUNDED"],
  REQUIRES_REAUTHORIZATION: ["FUNDED"],
};

export function orderPath(orderId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) {
    throw new Error("order_id must be 1-64 letters, digits, dashes, or underscores");
  }
  return resolve(ordersDir, `${orderId}.json`);
}

export function orderExists(orderId: string): boolean {
  return existsSync(orderPath(orderId));
}

export function loadOrder(orderId: string): OrderRecord {
  const path = orderPath(orderId);
  if (!existsSync(path)) {
    throw new Error(`order ${orderId} does not exist`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as OrderRecord;
}

export function listOrders(): OrderRecord[] {
  if (!existsSync(ordersDir)) return [];
  return readdirSync(ordersDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) =>
      JSON.parse(readFileSync(resolve(ordersDir, name), "utf8")) as OrderRecord,
    );
}

function persist(order: OrderRecord): void {
  mkdirSync(ordersDir, { recursive: true });
  const destination = orderPath(order.order_id);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(order, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, destination);
}

export function createOrder(input: {
  order_id: string;
  adapter: string;
  merchant: string;
  quoted_amount_pln: number;
  max_authorized_amount_pln: number;
  browser_session_id: string | null;
}): OrderRecord {
  if (orderExists(input.order_id)) {
    throw new Error(`order ${input.order_id} already exists`);
  }
  if (
    !Number.isFinite(input.quoted_amount_pln) ||
    input.quoted_amount_pln <= 0 ||
    !Number.isFinite(input.max_authorized_amount_pln) ||
    input.quoted_amount_pln > input.max_authorized_amount_pln
  ) {
    throw new Error(
      "quoted_amount_pln must be positive and no more than max_authorized_amount_pln",
    );
  }
  const now = new Date().toISOString();
  const order: OrderRecord = {
    order_id: input.order_id,
    adapter: input.adapter,
    merchant: input.merchant,
    quoted_amount_pln: input.quoted_amount_pln,
    max_authorized_amount_pln: input.max_authorized_amount_pln,
    funding: null,
    funds_reserved_pln: 0,
    browser_session_id: input.browser_session_id,
    payment_attempt_id: null,
    status: "CREATED",
    purchase: null,
    created_at: now,
    updated_at: now,
    history: [{ status: "CREATED", at: now, detail: "order created" }],
  };
  persist(order);
  return order;
}

export function transitionOrder(
  order: OrderRecord,
  to: OrderStatus,
  detail: string,
): OrderRecord {
  const allowed = TRANSITIONS[order.status];
  if (!allowed.includes(to)) {
    throw new Error(
      `order ${order.order_id} cannot move from ${order.status} to ${to}`,
    );
  }
  const now = new Date().toISOString();
  const next: OrderRecord = {
    ...order,
    status: to,
    updated_at: now,
    history: [...order.history, { status: to, at: now, detail }],
  };
  persist(next);
  return next;
}

export function recordFunding(
  order: OrderRecord,
  amountPln: number,
  reference: string | null,
): OrderRecord {
  if (order.status !== "CREATED") {
    throw new Error(
      `order ${order.order_id} must be CREATED to record funding; status is ${order.status}`,
    );
  }
  if (!Number.isFinite(amountPln) || amountPln < order.quoted_amount_pln) {
    throw new Error(
      `funding ${amountPln.toFixed(2)} PLN does not cover the quoted ${order.quoted_amount_pln.toFixed(2)} PLN`,
    );
  }
  const funded: OrderRecord = {
    ...order,
    funding: {
      amount_pln: amountPln,
      reference,
      received_at: new Date().toISOString(),
    },
    funds_reserved_pln: order.quoted_amount_pln,
  };
  return transitionOrder(
    funded,
    "FUNDED",
    `funded ${amountPln.toFixed(2)} PLN${reference ? ` (${reference})` : ""}; reserved ${funded.funds_reserved_pln.toFixed(2)} PLN`,
  );
}

/** Persist non-status field updates (payment_attempt_id, quoted amounts). */
export function updateOrder(
  order: OrderRecord,
  patch: Partial<OrderRecord>,
): OrderRecord {
  const next: OrderRecord = {
    ...order,
    ...patch,
    order_id: order.order_id,
    status: order.status,
    history: order.history,
    updated_at: new Date().toISOString(),
  };
  persist(next);
  return next;
}

export function recordPurchase(
  order: OrderRecord,
  purchase: Omit<OrderPurchase, "payment_attempt_id">,
): OrderRecord {
  const withPurchase: OrderRecord = {
    ...order,
    purchase: { ...purchase, payment_attempt_id: order.payment_attempt_id ?? "" },
  };
  persist(withPurchase);
  return transitionOrder(
    withPurchase,
    "PURCHASED",
    `merchant order ${purchase.merchant_order_id} confirmed at ${purchase.amount_pln.toFixed(2)} PLN`,
  );
}
