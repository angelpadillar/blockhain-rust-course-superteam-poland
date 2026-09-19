import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { writeJson } from "./files.js";
import { assertSecretPathsIgnored } from "./policy.js";
import { requireExactConfirmation } from "./prompts.js";
import {
  addVirtualAuthenticator,
  AltitudeSession,
  credentialPath,
  describeCredential,
  forgetStoredCredential,
  launch,
  openApp,
  waitForNewCredential,
  writeStoredCredential,
  CREDENTIAL_NAME,
  SESSION_ARTIFACT,
} from "./altitude/session.js";

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

async function waitForEnter(message: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) return;
  const readline = createInterface({ input: stdin, output: stdout });
  await readline.question(`${message}\nPress Enter to close the browser: `);
  readline.close();
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
    console.log(
      "  6. Record the create-card, fund and freeze controls; altitude:server needs those selectors to replace its stubs.",
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
    writeStoredCredential(credential);
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
  const session = await AltitudeSession.attach();
  try {
    console.log(
      `Injected stored passkey (credentialId=${session.credentialIdPrefix}…). Reloaded the app to trigger the sign-in ceremony.`,
    );
    await session.page.waitForTimeout(5_000);
    await session.screenshot("altitude-attest.png");
    writeJson(SESSION_ARTIFACT, {
      command: "attest",
      at: new Date().toISOString(),
      url: session.page.url(),
      rp_id: session.rpId,
      credential_id_prefix: session.credentialIdPrefix,
    });
    console.log(`Current URL: ${session.page.url()}`);
    console.log(
      `Screenshot saved to agent/out/screenshots/altitude-attest.png and artifact to ${SESSION_ARTIFACT}.`,
    );
    const signCount = await session.syncSignCount();
    if (signCount !== null) {
      console.log(`Stored signCount updated to ${signCount}.`);
    }
    await waitForEnter(
      "Check whether the dashboard is signed in without a human passkey prompt.",
    );
  } finally {
    await session.close();
  }
}

async function commandForget(): Promise<void> {
  assertSecretPathsIgnored();
  const target = credentialPath();
  if (!existsSync(target)) {
    console.log("No stored Altitude passkey file exists.");
    return;
  }
  await requireExactConfirmation(
    `This deletes ${target}. The passkey stays registered on the Altitude account until removed in the dashboard.`,
    "FORGET ALTITUDE PASSKEY",
  );
  forgetStoredCredential();
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
