import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isAbsolute, resolve } from "node:path";
import dotenv from "dotenv";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import { readJson, screenshotPath, writeJson } from "./files.js";
import { envPath, repoRoot } from "./paths.js";
import { assertSecretPathsIgnored } from "./policy.js";
import { requireExactConfirmation } from "./prompts.js";

/**
 * Supervised Altitude session harness.
 *
 *   open    - launch the dedicated Altitude profile for manual recon: install
 *             the 1Password extension into the profile once, log in with the
 *             existing passkey, and inspect card/security settings.
 *   enroll  - after that manual login, register an additional passkey on a CDP
 *             virtual authenticator and persist its credential material to the
 *             gitignored agent/out/altitude-passkey.json (mode 0600).
 *   attest  - inject the stored credential into a fresh virtual authenticator
 *             and open the app, so a WebAuthn ceremony resolves with no human
 *             passkey prompt.
 *   forget  - delete the stored credential file. Profile cookies are unchanged;
 *             log out inside the profile to end the dashboard session.
 *
 * The private key is never printed. Only the credential id prefix, relying
 * party id, and sign counter appear in logs and artifacts.
 */

interface StoredPasskeyCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  privateKey: string;
  userHandle?: string;
  signCount: number;
  largeBlob?: string;
}

interface AltitudePasskeyFile {
  version: 1;
  captured_at: string;
  updated_at: string;
  rp_id: string | null;
  credential: StoredPasskeyCredential;
}

const CREDENTIAL_NAME = "altitude-passkey.json";
const SESSION_ARTIFACT = "altitude-session.json";
const ENROLL_TIMEOUT_MS = 5 * 60_000;

dotenv.config({ path: envPath, quiet: true });

function resolveProfileDir(): string {
  const raw = process.env.ALTITUDE_PROFILE_DIR ?? "./agent/altitude-profile";
  return isAbsolute(raw) ? raw : resolve(repoRoot, raw);
}

function altitudeUrl(): string {
  const raw = (process.env.ALTITUDE_URL ?? "https://app.altitude.xyz").trim();
  if (!/^https:\/\/[\w.-]+(?::\d+)?(?:\/.*)?$/.test(raw)) {
    throw new Error("ALTITUDE_URL must be an https URL");
  }
  return raw;
}

async function launch(): Promise<BrowserContext> {
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
  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel: process.env.BROWSER_CHANNEL ?? "chrome",
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

async function openApp(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(altitudeUrl(), { waitUntil: "domcontentloaded" });
  return page;
}

async function waitForEnter(message: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) return;
  const readline = createInterface({ input: stdin, output: stdout });
  await readline.question(`${message}\nPress Enter to close the browser: `);
  readline.close();
}

async function addVirtualAuthenticator(
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

async function getCredentials(
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

async function waitForNewCredential(
  session: CDPSession,
  authenticatorId: string,
): Promise<StoredPasskeyCredential> {
  const deadline = Date.now() + ENROLL_TIMEOUT_MS;
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

function describeCredential(credential: StoredPasskeyCredential): string {
  return `rpId=${credential.rpId ?? "(none)"} credentialId=${credential.credentialId.slice(0, 16)}… signCount=${credential.signCount}`;
}

async function refreshStoredSignCount(
  session: CDPSession,
  authenticatorId: string,
): Promise<void> {
  let stored: AltitudePasskeyFile;
  try {
    stored = readJson<AltitudePasskeyFile>(CREDENTIAL_NAME);
  } catch {
    return;
  }
  const credentials = await getCredentials(session, authenticatorId);
  const match = credentials.find(
    (credential) => credential.credentialId === stored.credential.credentialId,
  );
  if (!match || match.signCount === stored.credential.signCount) return;
  writeJson(CREDENTIAL_NAME, {
    ...stored,
    updated_at: new Date().toISOString(),
    credential: { ...stored.credential, signCount: match.signCount },
  });
  console.log(`Stored signCount updated to ${match.signCount}.`);
}

async function commandOpen(): Promise<void> {
  assertSecretPathsIgnored();
  const context = await launch();
  try {
    await openApp(context);
    console.log("Altitude recon checklist:");
    console.log("  1. Sign in with the existing passkey (1Password prompt).");
    console.log(
      "  2. First run only: install the 1Password extension into this dedicated profile so passkey prompts can be completed here.",
    );
    console.log(
      "  3. In security settings, confirm whether a second passkey can be added.",
    );
    console.log(
      "  4. On the card, check whether per-transaction limits can be edited and whether editing re-prompts the passkey.",
    );
    console.log(
      "  5. Note the email used for card 3DS challenges so it stays bound to the dedicated fulfillment inbox.",
    );
    await waitForEnter("The browser stays open for inspection.");
  } finally {
    await context.close();
  }
}

async function commandEnroll(): Promise<void> {
  assertSecretPathsIgnored();
  const context = await launch();
  try {
    const page = await openApp(context);
    console.log(
      "Log in with the existing passkey (1Password), then open the passkey or security settings in the dashboard.",
    );
    await requireExactConfirmation(
      "The virtual authenticator will be armed after this confirmation. Any passkey created next is owned by this harness, not 1Password.",
      "ENROLL ALTITUDE PASSKEY",
    );
    const { session, authenticatorId } = await addVirtualAuthenticator(page);
    console.log(
      "Virtual authenticator armed. Click the dashboard's add-passkey control now.",
    );
    console.log(
      "If the control reports no available authenticator, reload the page once; the authenticator persists across reloads.",
    );
    const credential = await waitForNewCredential(session, authenticatorId);
    if (!/altitude|squads/i.test(credential.rpId ?? "")) {
      console.log(
        `Warning: relying party ${credential.rpId ?? "(none)"} does not look like an Altitude/Squads domain; storing anyway for inspection.`,
      );
    }
    writeJson(CREDENTIAL_NAME, {
      version: 1,
      captured_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      rp_id: credential.rpId ?? null,
      credential,
    } satisfies AltitudePasskeyFile);
    console.log(`Captured ${describeCredential(credential)}`);
    console.log(
      `Credential material written to agent/out/${CREDENTIAL_NAME} (0600, gitignored). Private key never logged.`,
    );
    await waitForEnter(
      "Enrollment complete. Keep this dashboard session for the attest step or close it.",
    );
  } finally {
    await context.close();
  }
}

async function commandAttest(): Promise<void> {
  assertSecretPathsIgnored();
  let stored: AltitudePasskeyFile;
  try {
    stored = readJson<AltitudePasskeyFile>(CREDENTIAL_NAME);
  } catch {
    throw new Error(
      `agent/out/${CREDENTIAL_NAME} is missing; run npm run altitude:session -- enroll first`,
    );
  }
  const context = await launch();
  try {
    const page = await openApp(context);
    const { session, authenticatorId } = await addVirtualAuthenticator(page);
    await session.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: stored.credential,
    });
    console.log(
      `Injected stored passkey (${describeCredential(stored.credential)}). Reloading app to trigger the sign-in ceremony.`,
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5_000);
    await page.screenshot({ path: screenshotPath("altitude-attest.png") });
    writeJson(SESSION_ARTIFACT, {
      command: "attest",
      at: new Date().toISOString(),
      url: page.url(),
      rp_id: stored.rp_id,
      credential_id_prefix: stored.credential.credentialId.slice(0, 16),
    });
    console.log(`Current URL: ${page.url()}`);
    console.log(
      "Screenshot saved to agent/out/screenshots/altitude-attest.png and artifact to altitude-session.json.",
    );
    await refreshStoredSignCount(session, authenticatorId);
    await waitForEnter(
      "Check whether the dashboard is signed in without a human passkey prompt.",
    );
  } finally {
    await context.close();
  }
}

async function commandForget(): Promise<void> {
  assertSecretPathsIgnored();
  const { rmSync } = await import("node:fs");
  const target = resolve(repoRoot, "agent/out", CREDENTIAL_NAME);
  if (!existsSync(target)) {
    console.log("No stored Altitude passkey file exists.");
    return;
  }
  await requireExactConfirmation(
    `This deletes ${target}. The passkey stays registered on the Altitude account until removed in the dashboard.`,
    "FORGET ALTITUDE PASSKEY",
  );
  rmSync(target);
  console.log(
    "Deleted the stored credential. The dashboard session cookies in agent/altitude-profile are unchanged; log out there to end the session.",
  );
}

const command = process.argv[2] ?? "";
const commands: Record<string, () => Promise<void>> = {
  open: commandOpen,
  enroll: commandEnroll,
  attest: commandAttest,
  forget: commandForget,
};

const run = commands[command];
if (!run) {
  console.error("usage: npm run altitude:session -- open|enroll|attest|forget");
  process.exit(1);
}

await run();
