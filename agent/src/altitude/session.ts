import { existsSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import dotenv from "dotenv";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { readJson, screenshotPath, writeJson } from "../files.js";
import { envPath, repoRoot } from "../paths.js";

/**
 * Shared Altitude browser/passkey primitives used by the `altitude:session`
 * CLI and the `altitude:server` daemon. The credential private key is only
 * ever read from and written to agent/out/altitude-passkey.json (mode 0600,
 * gitignored); nothing here logs or returns it.
 */

export interface StoredPasskeyCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  largeBlob?: string;
}

export interface AltitudePasskeyFile {
  version: 1;
  captured_at: string;
  updated_at: string;
  rp_id: string | null;
  credential: StoredPasskeyCredential;
}

export const CREDENTIAL_NAME = "altitude-passkey.json";
export const SESSION_ARTIFACT = "altitude-session.json";
export const ENROLL_TIMEOUT_MS = 5 * 60_000;

dotenv.config({ path: envPath, quiet: true });

export function resolveProfileDir(): string {
  const raw = process.env.ALTITUDE_PROFILE_DIR ?? "./agent/altitude-profile";
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
}

export function altitudeUrl(): string {
  const raw = (process.env.ALTITUDE_URL ?? "https://app.altitude.xyz").trim();
  return assertAltitudeUrl(raw);
}

export function assertAltitudeUrl(raw: string): string {
  if (!/^https:\/\/[\w.-]+(?::\d+)?(?:\/.*)?$/.test(raw)) {
    throw new Error("ALTITUDE_URL must be an https URL");
  }
  return raw;
}

export function credentialPath(): string {
  return resolve(repoRoot, "agent/out", CREDENTIAL_NAME);
}

export function readStoredCredential(): AltitudePasskeyFile {
  try {
    return readJson<AltitudePasskeyFile>(CREDENTIAL_NAME);
  } catch {
    throw new Error(
      `agent/out/${CREDENTIAL_NAME} is missing; run npm run altitude:session -- enroll first`,
    );
  }
}

export function writeStoredCredential(
  credential: StoredPasskeyCredential,
  at = new Date(),
): void {
  writeJson(CREDENTIAL_NAME, {
    version: 1,
    captured_at: at.toISOString(),
    updated_at: at.toISOString(),
    rp_id: credential.rpId ?? null,
    credential,
  } satisfies AltitudePasskeyFile);
}

export function forgetStoredCredential(): boolean {
  const target = credentialPath();
  if (!existsSync(target)) return false;
  rmSync(target);
  return true;
}

export function describeCredential(
  credential: StoredPasskeyCredential,
): string {
  return `rpId=${credential.rpId ?? "(none)"} credentialId=${credential.credentialId.slice(0, 16)}… signCount=${credential.signCount}`;
}

export async function launch(): Promise<BrowserContext> {
  const profileDir = resolveProfileDir();
  const args = ["--disable-blink-features=AutomationControlled"];
  const extensionDir = (process.env.ALTITUDE_EXTENSION_DIR ?? "").trim();
  if (extensionDir) {
    const resolved = isAbsolute(extensionDir)
      ? extensionDir
      : resolve(repoRoot, extensionDir);
    if (!existsSync(resolved)) {
      throw new Error(`ALTITUDE_EXTENSION_DIR does not exist: ${resolved}`);
    }
    args.push(
      `--disable-extensions-except=${resolved}`,
      `--load-extension=${resolved}`,
    );
  }
  const executablePath = (process.env.ALTITUDE_BROWSER_EXECUTABLE ?? "").trim();
  try {
    return await chromium.launchPersistentContext(profileDir, {
      ...(executablePath
        ? { executablePath }
        : { channel: process.env.BROWSER_CHANNEL ?? "chrome" }),
      headless: false,
      viewport: null,
      args,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/Opening in existing browser session|profile.*in use/i.test(message)) {
      throw new Error(
        "agent/altitude-profile is already open in Chrome. Quit the dedicated Altitude window, then rerun the command.",
      );
    }
    throw error;
  }
}

export async function openApp(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(altitudeUrl(), { waitUntil: "domcontentloaded" });
  return page;
}

export async function addVirtualAuthenticator(
  page: Page,
): Promise<{ session: CDPSession; authenticatorId: string }> {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return { session, authenticatorId };
}

export async function getCredentials(
  session: CDPSession,
  authenticatorId: string,
): Promise<StoredPasskeyCredential[]> {
  const { credentials } = await session.send("WebAuthn.getCredentials", {
    authenticatorId,
  });
  return credentials.map((credential) => {
    const stored: StoredPasskeyCredential = {
      credentialId: credential.credentialId,
      isResidentCredential: credential.isResidentCredential,
      privateKey: credential.privateKey,
      signCount: credential.signCount,
    };
    if (credential.rpId !== undefined) stored.rpId = credential.rpId;
    if (credential.userHandle !== undefined)
      stored.userHandle = credential.userHandle;
    if (credential.largeBlob !== undefined)
      stored.largeBlob = credential.largeBlob;
    return stored;
  });
}

export async function waitForNewCredential(
  session: CDPSession,
  authenticatorId: string,
  timeoutMs = ENROLL_TIMEOUT_MS,
): Promise<StoredPasskeyCredential> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const credentials = await getCredentials(session, authenticatorId);
    const credential = credentials[0];
    if (credential) return credential;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(
    "no passkey was registered on the virtual authenticator within 5 minutes; rerun altitude:session enroll",
  );
}

export async function refreshStoredSignCount(
  session: CDPSession,
  authenticatorId: string,
): Promise<number | null> {
  let stored: AltitudePasskeyFile;
  try {
    stored = readJson<AltitudePasskeyFile>(CREDENTIAL_NAME);
  } catch {
    return null;
  }
  const credentials = await getCredentials(session, authenticatorId);
  const match = credentials.find(
    (credential) => credential.credentialId === stored.credential.credentialId,
  );
  if (!match || match.signCount === stored.credential.signCount) return null;
  writeJson(CREDENTIAL_NAME, {
    ...stored,
    updated_at: new Date().toISOString(),
    credential: { ...stored.credential, signCount: match.signCount },
  });
  return match.signCount;
}

/**
 * A launched profile with the stored passkey injected into a fresh virtual
 * authenticator, so WebAuthn ceremonies resolve without a human prompt.
 */
export class AltitudeSession {
  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly cdp: CDPSession,
    readonly authenticatorId: string,
    readonly credentialIdPrefix: string,
    readonly rpId: string | null,
    readonly startedAt: string,
  ) {}

  static async attach(): Promise<AltitudeSession> {
    const stored = readStoredCredential();
    const context = await launch();
    try {
      const page = await openApp(context);
      const { session, authenticatorId } = await addVirtualAuthenticator(page);
      await session.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: stored.credential,
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      return new AltitudeSession(
        context,
        page,
        session,
        authenticatorId,
        stored.credential.credentialId.slice(0, 16),
        stored.rp_id,
        new Date().toISOString(),
      );
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async screenshot(name: string): Promise<string> {
    const path = screenshotPath(name);
    await this.page.screenshot({ path });
    return path;
  }

  async syncSignCount(): Promise<number | null> {
    return refreshStoredSignCount(this.cdp, this.authenticatorId);
  }

  async close(): Promise<void> {
    await this.syncSignCount();
    await this.context.close();
  }
}
