import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { assertSecretPathsIgnored } from "./policy.js";
import {
  readBalance,
  runCardCommand,
  validateCardCommand,
  CARD_COMMANDS,
  isLiveCardOps,
  resolveAttachMode,
  resolveLimitFrequency,
  type CardCommand,
} from "./altitude/commands.js";
import {
  AltitudeSession,
  altitudeUrl,
  hasStoredCredential,
} from "./altitude/session.js";

/**
 * Localhost daemon that owns one supervised Altitude browser session.
 *
 * The session is the persistent Chrome profile with the stored passkey
 * injected into a virtual authenticator, or a supervised browser window where
 * a human completes login. Balance, create, and freeze use live dashboard
 * flows behind a dry-run gate; fund and close remain stubs.
 *
 *   GET  /health          daemon and session state
 *   POST /session/attach  launch the profile in injected or supervised mode
 *   POST /session/close   close the browser
 *   GET  /balance         live balance read (dry-run is not applicable)
 *   POST /card/<command>  live create/freeze; stubbed fund/close
 */

const HOST = "127.0.0.1";

function port(): number {
  const raw = (process.env.ALTITUDE_SERVER_PORT ?? "8787").trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error(
      "ALTITUDE_SERVER_PORT must be an integer between 1024 and 65535",
    );
  }
  return parsed;
}

function token(): string {
  const raw = (process.env.ALTITUDE_SERVER_TOKEN ?? "").trim();
  if (raw.length < 16) {
    throw new Error(
      "ALTITUDE_SERVER_TOKEN must be set to a random value of at least 16 characters",
    );
  }
  return raw;
}

function isAuthorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 64_000) throw new Error("request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** One browser, one command at a time. */
class Daemon {
  private session: AltitudeSession | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  state(): Record<string, unknown> {
    if (!this.session) return { attached: false };
    return {
      attached: true,
      mode: this.session.mode,
      url: this.session.page.url(),
      rp_id: this.session.rpId,
      credential_id_prefix: this.session.credentialIdPrefix,
      started_at: this.session.startedAt,
      ...(this.session.mode === "supervised"
        ? {
            next_step:
              "complete the passkey login in the browser window, then issue commands",
          }
        : {}),
    };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  attach(mode: "injected" | "supervised"): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      if (this.session) return this.state();
      this.session =
        mode === "injected"
          ? await AltitudeSession.attach()
          : await AltitudeSession.attachSupervised();
      return this.state();
    });
  }

  close(): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      if (!this.session) return { attached: false, closed: false };
      await this.session.close();
      this.session = null;
      return { attached: false, closed: true };
    });
  }

  withSession<T>(work: (session: AltitudeSession) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const session = this.session;
      if (!session) {
        throw new Error("no session is attached; POST /session/attach first");
      }
      return work(session);
    });
  }
}

const daemon = new Daemon();

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${HOST}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (request.method === "GET" && (path === "/" || path === "/health")) {
    send(response, 200, {
      ok: true,
      target: altitudeUrl(),
      live_card_ops: isLiveCardOps(),
      card_limit_frequency: resolveLimitFrequency(
        process.env.ALTITUDE_CARD_LIMIT_FREQUENCY,
      ),
      ...daemon.state(),
    });
    return;
  }
  if (request.method === "POST" && path === "/session/attach") {
    const body = await readBody(request);
    const requested =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).mode
        : body;
    const mode = resolveAttachMode(requested, hasStoredCredential());
    send(response, 200, { ok: true, ...(await daemon.attach(mode)) });
    return;
  }
  if (request.method === "POST" && path === "/session/close") {
    send(response, 200, { ok: true, ...(await daemon.close()) });
    return;
  }
  if (request.method === "GET" && path === "/balance") {
    send(response, 200, await daemon.withSession(readBalance));
    return;
  }
  if (request.method === "POST" && path.startsWith("/card/")) {
    const command = path.slice("/card/".length);
    if (!CARD_COMMANDS.includes(command as CardCommand)) {
      send(response, 404, {
        ok: false,
        error: `unknown card command; expected one of ${CARD_COMMANDS.join(", ")}`,
      });
      return;
    }
    const body = (await readBody(request)) as Record<string, unknown>;
    const validated = validateCardCommand({ ...body, command });
    send(
      response,
      200,
      await daemon.withSession((session) => runCardCommand(session, validated)),
    );
    return;
  }
  send(response, 404, { ok: false, error: "unknown endpoint" });
}

assertSecretPathsIgnored();
const expectedToken = token();
const server = createServer((request, response) => {
  const remote = request.socket.remoteAddress ?? "";
  if (
    remote !== "127.0.0.1" &&
    remote !== "::1" &&
    remote !== "::ffff:127.0.0.1"
  ) {
    response.destroy();
    return;
  }
  if (!isAuthorized(request, expectedToken)) {
    send(response, 401, {
      ok: false,
      error: "missing or invalid bearer token",
    });
    return;
  }
  route(request, response).catch((error: unknown) => {
    send(response, 400, { ok: false, error: (error as Error).message });
  });
});

server.listen(port(), HOST, () => {
  console.log(`Altitude daemon listening on http://${HOST}:${port()}`);
  console.log(`Target: ${altitudeUrl()}`);
  console.log(
    "Card actions are stubs pending dashboard recon; no account mutation is possible yet.",
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void daemon.close().finally(() => {
      server.close();
      process.exit(0);
    });
  });
}
