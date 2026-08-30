import { runFulfillmentAdapter } from "./adapter/runner.js";
import { runChecklist } from "./checklist.js";
import { loadConfig, loadRuntimeOptions, renderNote } from "./config.js";
import { finalizeFromPaidFile } from "./finalize.js";
import { ensureOutputDirectories, writeJson } from "./files.js";
import { assertSecretPathsIgnored, redactSensitive } from "./policy.js";

async function main(): Promise<void> {
  ensureOutputDirectories();
  assertSecretPathsIgnored();
  const config = loadConfig();
  const options = loadRuntimeOptions();
  const note = renderNote(config.note, options.nonce);
  const command = process.argv[2];

  if (command === "checklist") {
    await runChecklist(config, options, note);
    return;
  }
  if (command === "prepare") {
    await runFulfillmentAdapter(config, options, note);
    return;
  }
  if (command === "finalize") {
    finalizeFromPaidFile(config, options, note);
    return;
  }
  throw new Error(
    "usage: npm run checklist | npm run order:prepare | npm run finalize",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = redactSensitive(message, [
    process.env.CARD_PAN ?? "",
    process.env.CARD_CVC ?? "",
  ]);
  writeJson("last-run.json", {
    status: "hard_fail",
    message: safeMessage,
    ts: new Date().toISOString(),
  });
  console.error(`HARD FAIL: ${safeMessage}`);
  process.exitCode = 1;
});
