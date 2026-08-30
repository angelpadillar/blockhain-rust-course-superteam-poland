import { AgentMailClient } from "agentmail";
import { classifyMail, parsePaymentThreeDs } from "./otp.js";
import type { OtpOutput, RuntimeOptions } from "./types.js";

const APATA_SENDER = "no-reply@apata.io";
const ALTITUDE_LOGIN_SENDER = "notifications@altitude.squads.xyz";

let client: AgentMailClient | null = null;
let clientKey: string | null = null;

function senderAddress(value: string): string | null {
  const bracketed = value.match(/<([^>]+)>/)?.[1];
  return (
    (
      bracketed ??
      value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/i)?.[0] ??
      null
    )?.toLocaleLowerCase() ?? null
  );
}

function isWoltSender(value: string): boolean {
  const address = senderAddress(value);
  if (!address) return false;
  const domain = address.split("@")[1] ?? "";
  return domain === "wolt.com" || domain.endsWith(".wolt.com");
}

function isPyszneSender(value: string): boolean {
  const address = senderAddress(value);
  if (!address) return false;
  const domain = address.split("@")[1] ?? "";
  return ["pyszne.pl", "takeaway.com", "just-eat.com"].some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
  );
}

function getAgentMail(apiKey: string): AgentMailClient {
  if (!client || clientKey !== apiKey) {
    client = new AgentMailClient({ apiKey });
    clientKey = apiKey;
  }
  return client;
}

export interface AgentMailMessageShape {
  from: string;
  subject?: string;
  text?: string;
  extractedText?: string;
  html?: string;
  timestamp: Date;
}

function textFromHtml(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function messageBody(message: AgentMailMessageShape): string {
  return (
    message.extractedText ??
    message.text ??
    (message.html ? textFromHtml(message.html) : "")
  );
}

/** Build the parser input in memory. The full body is never logged or persisted. */
export function paymentMailText(message: AgentMailMessageShape): string {
  const body = messageBody(message);
  return [
    `From: ${message.from}`,
    `Subject: ${message.subject ?? ""}`,
    "Body:",
    body,
  ].join("\n");
}

export function parseWoltLoginLink(
  message: AgentMailMessageShape,
  notBefore: Date,
): string | null {
  if (message.timestamp < notBefore || !isWoltSender(message.from)) return null;
  if (
    !/log\s*in|sign\s*in|login|verification|welcome\s+to\s+wolt|magic\s+link/i.test(
      message.subject ?? "",
    )
  )
    return null;
  const source = `${messageBody(message)}\n${message.html ?? ""}`;
  const matches = source.match(/https:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/&amp;/gi, "&").replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLocaleLowerCase();
      if (host === "wolt.com" || host.endsWith(".wolt.com")) {
        return url.toString();
      }
    } catch {
      // Ignore malformed links and continue looking for an authenticated host.
    }
  }
  throw new Error(
    "fresh Wolt login mail did not contain an HTTPS link on a wolt.com host",
  );
}

export type PyszneLoginChallenge =
  { kind: "link"; link: string } | { kind: "otp"; otp: string };

export function parsePyszneLoginChallenge(
  message: AgentMailMessageShape,
  notBefore: Date,
): PyszneLoginChallenge | null {
  if (message.timestamp < notBefore || !isPyszneSender(message.from)) {
    return null;
  }
  if (
    !/pyszne|just eat|log\s*in|sign\s*in|verification|verify|code|passwordless|kod\s+weryfikacyjny|zalogowa(?:ć|c)|logowanie/i.test(
      message.subject ?? "",
    )
  ) {
    return null;
  }
  const body = messageBody(message);
  const source = `${body}\n${message.html ?? ""}`;
  const matches = source.match(/https:\/\/[^\s<>"']+/gi) ?? [];
  for (const raw of matches) {
    const candidate = raw.replace(/&amp;/gi, "&").replace(/[),.;]+$/, "");
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLocaleLowerCase();
      if (host === "pyszne.pl" || host.endsWith(".pyszne.pl")) {
        return { kind: "link", link: url.toString() };
      }
    } catch {
      // Ignore malformed or non-Pyszne links.
    }
  }
  const contextualOtp =
    body.match(
      /(?:enter|use)\s+this\s+(?:verification\s+)?code\s+to\s+log\s+in[^A-Z0-9]{0,30}([A-Z0-9]{6})\b/i,
    )?.[1] ??
    body.match(
      /wpisz\s+kod,?\s+aby\s+się\s+zalogować[^A-Z0-9]{0,30}([A-Z0-9]{6})\b/i,
    )?.[1];
  if (contextualOtp) {
    return { kind: "otp", otp: contextualOtp.toLocaleUpperCase() };
  }
  throw new Error(
    "fresh Pyszne login mail contained neither an auth.pyszne.pl link nor an unambiguous 6-character login code",
  );
}

export function parseAgentMailPaymentMessage(
  message: AgentMailMessageShape,
  notBefore: Date,
): OtpOutput | null {
  if (message.timestamp < notBefore) return null;
  const from = senderAddress(message.from);
  if (from !== APATA_SENDER && from !== ALTITUDE_LOGIN_SENDER) return null;

  const text = paymentMailText(message);
  const classification = classifyMail(text);
  if (classification === "altitude_login_otp") {
    throw new Error(
      "AgentMail received an Altitude account-login OTP; it is never valid for payment 3DS",
    );
  }
  if (classification !== "payment_3ds") {
    throw new Error(
      "AgentMail received mail from an allowed OTP sender with an unknown shape; payment 3DS is blocked",
    );
  }
  return {
    ...parsePaymentThreeDs(text),
    ts: message.timestamp.toISOString(),
  };
}

/**
 * Read only the dedicated fulfillment inbox and return one fresh payment OTP.
 * No labels, messages, or inbox state are changed.
 */
export async function readFreshAgentMailOtp(
  options: RuntimeOptions,
  notBefore: Date,
): Promise<OtpOutput | null> {
  if (!options.agentMailApiKey) {
    throw new Error("AgentMail API key is unavailable");
  }
  const am = getAgentMail(options.agentMailApiKey);
  const response = await am.inboxes.messages.list(options.agentMailInbox, {
    limit: 20,
    after: notBefore,
    ascending: true,
  });

  for (const item of response.messages ?? []) {
    const from = senderAddress(item.from);
    if (from !== APATA_SENDER && from !== ALTITUDE_LOGIN_SENDER) continue;
    const message = await am.inboxes.messages.get(
      options.agentMailInbox,
      item.messageId,
    );
    const parsed = parseAgentMailPaymentMessage(message, notBefore);
    if (parsed) return parsed;
  }
  return null;
}

/** Read-only connectivity check. Returns subject lines only, never bodies. */
export async function listRecentAgentMailSubjects(
  options: RuntimeOptions,
  limit = 5,
): Promise<string[]> {
  if (!options.agentMailApiKey) {
    throw new Error("AgentMail API key is unavailable");
  }
  const am = getAgentMail(options.agentMailApiKey);
  const response = await am.inboxes.messages.list(options.agentMailInbox, {
    limit,
    includeSpam: true,
    includeUnauthenticated: true,
    includeBlocked: true,
  });
  return (response.messages ?? []).map(
    (message) => message.subject?.trim() || "(no subject)",
  );
}

/** Snapshot Wolt message IDs so login polling never consumes an older link. */
export async function listRecentWoltMessageIds(
  options: RuntimeOptions,
): Promise<Set<string>> {
  if (!options.agentMailApiKey) {
    throw new Error("AgentMail API key is unavailable");
  }
  const am = getAgentMail(options.agentMailApiKey);
  const response = await am.inboxes.messages.list(options.agentMailInbox, {
    limit: 20,
    includeSpam: true,
    includeUnauthenticated: true,
    includeBlocked: true,
  });
  return new Set(
    (response.messages ?? [])
      .filter((message) => isWoltSender(message.from))
      .map((message) => message.messageId),
  );
}

/** Snapshot Pyszne/Takeaway message IDs so an older login cannot be reused. */
export async function listRecentPyszneMessageIds(
  options: RuntimeOptions,
): Promise<Set<string>> {
  if (!options.agentMailApiKey) {
    throw new Error("AgentMail API key is unavailable");
  }
  const am = getAgentMail(options.agentMailApiKey);
  const response = await am.inboxes.messages.list(options.agentMailInbox, {
    limit: 20,
    includeSpam: true,
    includeUnauthenticated: true,
    includeBlocked: true,
  });
  return new Set(
    (response.messages ?? [])
      .filter((message) => isPyszneSender(message.from))
      .map((message) => message.messageId),
  );
}

/** Poll the dedicated inbox for one fresh Wolt magic link, kept in memory. */
export async function pollForWoltLoginLink(
  options: RuntimeOptions,
  notBefore: Date,
  excludedMessageIds: ReadonlySet<string> = new Set(),
): Promise<string> {
  if (!options.agentMailApiKey) {
    throw new Error("AgentMail API key is unavailable");
  }
  const am = getAgentMail(options.agentMailApiKey);
  const deadline = Date.now() + options.woltLoginTimeoutMs;
  while (Date.now() < deadline) {
    const response = await am.inboxes.messages.list(options.agentMailInbox, {
      limit: 20,
      after: notBefore,
      ascending: true,
      includeSpam: true,
      includeUnauthenticated: true,
      includeBlocked: true,
    });
    for (const item of response.messages ?? []) {
      if (excludedMessageIds.has(item.messageId)) continue;
      if (!isWoltSender(item.from)) continue;
      if (
        !/log\s*in|sign\s*in|login|verification|welcome\s+to\s+wolt|magic\s+link/i.test(
          item.subject ?? "",
        )
      )
        continue;
      const message = await am.inboxes.messages.get(
        options.agentMailInbox,
        item.messageId,
      );
      const link = parseWoltLoginLink(message, notBefore);
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `No fresh Wolt magic-link email arrived within ${Math.round(options.woltLoginTimeoutMs / 1_000)} seconds`,
  );
}

/** Poll only the dedicated inbox for one fresh Pyszne login challenge. */
export async function pollForPyszneLoginChallenge(
  options: RuntimeOptions,
  notBefore: Date,
  excludedMessageIds: ReadonlySet<string> = new Set(),
): Promise<PyszneLoginChallenge> {
  if (!options.agentMailApiKey) {
    throw new Error("AgentMail API key is unavailable");
  }
  const am = getAgentMail(options.agentMailApiKey);
  const deadline = Date.now() + options.pyszneLoginTimeoutMs;
  while (Date.now() < deadline) {
    const response = await am.inboxes.messages.list(options.agentMailInbox, {
      limit: 20,
      after: notBefore,
      ascending: true,
      includeSpam: true,
      includeUnauthenticated: true,
      includeBlocked: true,
    });
    for (const item of response.messages ?? []) {
      if (excludedMessageIds.has(item.messageId)) continue;
      if (!isPyszneSender(item.from)) continue;
      const message = await am.inboxes.messages.get(
        options.agentMailInbox,
        item.messageId,
      );
      const challenge = parsePyszneLoginChallenge(message, notBefore);
      if (challenge) return challenge;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `No fresh Pyszne login email arrived within ${Math.round(options.pyszneLoginTimeoutMs / 1_000)} seconds`,
  );
}
