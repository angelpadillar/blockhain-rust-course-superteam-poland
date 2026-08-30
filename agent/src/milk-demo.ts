import { runChecklist } from "./checklist.js";
import { loadConfig, loadRuntimeOptions, renderNote } from "./config.js";
import { ensureOutputDirectories } from "./files.js";

async function main(): Promise<void> {
  ensureOutputDirectories();
  const config = loadConfig();
  const options = loadRuntimeOptions();
  const note = renderNote(config.note, options.nonce);
  const milkItems = config.items.filter(
    (item) =>
      /\b(?:milk|mleko)\b/i.test(item.query) &&
      !/chocolate|czekolad|bar|baton|cookie|ciast|candy/i.test(item.query),
  );
  if (
    config.job_kind !== "food" ||
    config.adapter !== "pyszne" ||
    milkItems.length !== 1 ||
    milkItems[0]?.qty !== 2 ||
    !config.constraints.includes("regular-cow-milk-1l-3.2-percent") ||
    !config.constraints.includes("no-substitutions")
  ) {
    throw new Error(
      "config.local.json is not the constrained 2 × 1 L Pyszne milk demo",
    );
  }
  if (options.allowPay || options.allowThreeDsSubmit) {
    throw new Error(
      "the milk MCP demo requires ALLOW_PAY=false and ALLOW_3DS_SUBMIT=false",
    );
  }
  await runChecklist(config, options, note);
  console.log("\nMILK MCP DEMO READY");
  console.log("No browser was opened and no payment was authorized.");
  console.log("Paste this request into the active Codex task:");
  console.log(
    "At Sklep Blumiś Ciesielskiego on Pyszne, prepare the exact configured milk-and-snack basket for the configured venue. Verify 2 × 1 L regular cow’s milk at exactly 3.2%, every configured top-up and quantity, no substitutions, and the final landed total. Maximum 70 PLN. Stop for approval before payment.",
  );
}

main().catch((error: unknown) => {
  console.error(
    `MILK DEMO FAIL CLOSED: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
