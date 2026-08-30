import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { outDir, screenshotsDir } from "./paths.js";

export function ensureOutputDirectories(): void {
  mkdirSync(screenshotsDir, { recursive: true });
}

export function outputPath(name: string): string {
  if (basename(name) !== name)
    throw new Error("output filename must not contain a path");
  return resolve(outDir, name);
}

export function screenshotPath(name: string): string {
  if (!/^[a-z0-9-]+\.png$/i.test(name)) {
    throw new Error("screenshot filename must be a simple .png name");
  }
  return resolve(screenshotsDir, name);
}

export function writeJson(name: string, value: unknown): void {
  ensureOutputDirectories();
  const destination = outputPath(name);
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, destination);
}

export function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(outputPath(name), "utf8")) as T;
}

export function sha256File(path: string | undefined): string | null {
  if (!path) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
