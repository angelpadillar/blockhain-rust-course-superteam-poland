export type JobKind = "food" | "merch" | "handmade" | "generic";
export type AdapterName =
  "wolt" | "glovo" | "pyszne" | "local_print" | "local_shop" | "manual";
export type DestinationType = "venue" | "home";
export type ThreeDsChannel = "email";
export type QuoteSla = "same-day" | "manual";
export type PaymentCurrency = string;
export type MailClassification =
  "altitude_login_otp" | "payment_3ds" | "unknown";
export type MailSource = "stub" | "agentmail" | "nango";

export interface FulfillmentItem {
  query: string;
  qty: number;
}

export interface AgentSelectionPolicy {
  mode: "agent_curated";
  participants: number;
  milk_liters: number;
  milk_fat_percent: 3.2;
  beverage_servings_min: number;
  allow_100_percent_juice: true;
  allow_office_safe_functional_drinks: true;
  include_healthy_snacks: true;
}

export interface FulfillmentSpec {
  item: string;
  design_file: string | null;
  text_fallback: string;
  qty: number;
  note: string;
}

export interface AgentConfig {
  job_kind: JobKind;
  adapter: AdapterName;
  city: "Kraków";
  venue_label: string;
  destination_type: DestinationType;
  address_line: string;
  latlon_hint: string | null;
  recipient_name: string;
  phone: string | null;
  contact_email: string;
  three_ds_email: string;
  merchant_descriptor: string | null;
  spec: FulfillmentSpec | null;
  items: FulfillmentItem[];
  selection: AgentSelectionPolicy | null;
  note: string;
  max_pln: number;
  constraints: string[];
  prefer_3ds_channel: ThreeDsChannel;
}

export interface RuntimeOptions {
  allowPay: boolean;
  allowThreeDsSubmit: boolean;
  allowSaveCard: boolean;
  cardRail: string;
  browserChannel: string;
  profileDir: string;
  glovoProfileDir: string;
  pyszneProfileDir: string;
  mailSource: MailSource;
  agentMailApiKey: string | null;
  agentMailInbox: string;
  woltLoginMode: "manual" | "agentmail";
  woltLoginTimeoutMs: number;
  pyszneLoginMode: "manual" | "agentmail";
  pyszneLoginTimeoutMs: number;
  solanaRpcUrl: string;
  fulfillmentOracleWallet: string;
  proofFile?: string;
  nonce?: string;
}

export interface CardSecrets {
  pan: string;
  exp: string;
  cvc: string;
  name: string;
  last4: string;
  billingAddressLine: string;
  billingCity: "Kraków";
  billingRegion: string;
  billingPostalCode: string;
  billingCountry: "PL";
}

export interface QuoteOutput {
  job_kind: JobKind;
  adapter: AdapterName;
  landed_pln: number | null;
  max_pln: number;
  note: string;
  spec_hash: string;
  venue_label: string;
  sla: QuoteSla;
  city: "Kraków";
  currency: PaymentCurrency;
  currency_exponent: number;
  charge_currency: PaymentCurrency | null;
  charge_currency_exponent: number | null;
  charge_amount: number | null;
  settlement_units_per_charge_unit: number | null;
  /** @deprecated Kraków quote compatibility alias. */
  pln_per_charge_unit: number | null;
  source_url: string | null;
  captured_at: string;
  breakdown_pln?: {
    item_subtotal: number;
    small_order_fee: number;
    service_fee: number;
    delivery_fee: number;
    tip: number;
    other_fees: number;
  };
}

export interface FulfillmentOutput {
  order_id: string;
  status: "paid" | "confirmed";
  amount_pln: number;
  note: string;
  photo_sha256: string | null;
  job_kind: JobKind;
  adapter: AdapterName;
  city: "Kraków";
  completed_at: string;
}

export interface OtpOutput {
  kind: "payment_3ds";
  provider: "apata";
  currency: PaymentCurrency;
  amount: number;
  merchant: string;
  from: string;
  otp: string;
  ts: string;
}

export interface PaidOutput {
  order_id: string;
  status: "paid" | "confirmed";
  amount_pln: number;
}

export interface ThreeDsAudit {
  provider: "apata" | "none";
  mode: "frictionless" | "email_otp_submitted" | "human_completed";
  currency: PaymentCurrency;
  amount: number;
  merchant: string;
  from: string | null;
  completed_at: string;
}

export interface PaymentAttemptArtifact {
  kind: "payment_attempt";
  quote_sha256: string;
  currency: PaymentCurrency;
  amount_minor: number;
  merchant: string;
  card_last4: string;
  attempted_at: string;
}

export interface PaymentAuthArtifact {
  kind: "payment_auth";
  provider: "apata" | "none";
  mode: ThreeDsAudit["mode"];
  currency: PaymentCurrency;
  amount_minor: number;
  merchant: string;
  from: string | null;
  completed_at: string;
}

export interface PurchaseArtifact {
  kind: "purchase";
  currency: PaymentCurrency;
  amount_minor: number;
  order_id: string;
  merchant: string;
  confirmed_at: string;
}
