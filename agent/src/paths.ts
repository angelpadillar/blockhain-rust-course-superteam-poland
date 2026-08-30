import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(agentRoot, "..");
export const outDir = resolve(agentRoot, "out");
export const screenshotsDir = resolve(outDir, "screenshots");
export const configPath = resolve(agentRoot, "config.local.json");
export const envPath = resolve(agentRoot, ".env");
