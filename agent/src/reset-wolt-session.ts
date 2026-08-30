import "dotenv/config";
import path from "node:path";
import { chromium } from "playwright-core";

const configuredProfile =
  process.env.WOLT_PROFILE_DIR ?? "./agent/chrome-profile";
const profileDir = path.resolve(process.cwd(), "..", configuredProfile);

const context = await chromium.launchPersistentContext(profileDir, {
  channel: process.env.BROWSER_CHANNEL ?? "chrome",
  headless: true,
});

try {
  await context.clearCookies({ domain: /(^|\.)wolt\.com$/i });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://wolt.com", { waitUntil: "domcontentloaded" });
  const session = await context.newCDPSession(page);
  await session.send("Storage.clearDataForOrigin", {
    origin: "https://wolt.com",
    storageTypes:
      "cookies,local_storage,indexeddb,service_workers,cache_storage,websql",
  });

  console.log(
    "Cleared Wolt cookies and site storage from the dedicated demo profile.",
  );
  console.log("No other Chrome profile or mailbox state was changed.");
} finally {
  await context.close();
}
