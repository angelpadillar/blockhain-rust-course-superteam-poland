import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ensureOutputDirectories, writeJson } from "./files.js";
import { outDir } from "./paths.js";
import {
  assertCardAttemptCanArchive,
  type CardAttemptRecord,
} from "./policy.js";

export function demoArchiveName(date: Date): string {
  if (Number.isNaN(date.valueOf())) throw new Error("reset date is invalid");
  return date.toISOString().replace(/[:.]/g, "-");
}

function activeOutputEntries(): string[] {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir).filter((entry) => entry !== "archive");
}

async function main(): Promise<void> {
  ensureOutputDirectories();
  const attemptPath = resolve(outDir, "card-attempt.json");
  if (existsSync(attemptPath)) {
    const attempt = JSON.parse(
      readFileSync(attemptPath, "utf8"),
    ) as CardAttemptRecord;
    assertCardAttemptCanArchive(attempt);
  }
  const entries = activeOutputEntries();
  console.log("RECOVERABLE DEMO RESET");
  console.log(
    "The current agent/out artifacts will be archived inside the gitignored output directory.",
  );
  console.log(
    "The browser profiles, config, .env, and Anchor program are untouched.",
  );
  console.log(`Active output entries: ${entries.length}`);
  const readline = createInterface({ input: stdin, output: stdout });
  const answer = await readline.question(
    "Type ARCHIVE AND RESET DEMO to continue: ",
  );
  readline.close();
  if (answer !== "ARCHIVE AND RESET DEMO") {
    throw new Error("demo reset confirmation did not match; nothing changed");
  }

  const archiveName = demoArchiveName(new Date());
  const archiveRoot = resolve(outDir, "archive");
  mkdirSync(archiveRoot, { recursive: true });
  const archiveDir = resolve(archiveRoot, archiveName);
  mkdirSync(archiveDir, { recursive: false });
  for (const entry of entries) {
    const source = resolve(outDir, entry);
    if (basename(source) !== entry) {
      throw new Error("unsafe output entry encountered during reset");
    }
    renameSync(source, resolve(archiveDir, entry));
  }
  ensureOutputDirectories();
  writeJson("reset.json", {
    status: "ready_for_fresh_demo",
    archived_to: archiveDir,
    archived_entries: entries.length,
    reset_at: new Date().toISOString(),
  });
  console.log(`Archived the prior run to ${archiveDir}`);
  console.log(
    "Fresh agent/out state is ready. Payment flags remain unchanged.",
  );
}

main().catch((error: unknown) => {
  console.error(`RESET FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
});
