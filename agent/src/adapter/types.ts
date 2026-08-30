import type { QuoteOutput } from "../types.js";

export interface FulfillmentAdapter {
  searchOrOpen(): Promise<void>;
  buildCartOrOrderForm(): Promise<void>;
  fillDestination(): Promise<void>;
  attachNote(): Promise<void>;
  quote(): Promise<QuoteOutput | null>;
  stopAtPaywall(): Promise<void>;
  pay?(): Promise<void>;
  close(): Promise<void>;
}
