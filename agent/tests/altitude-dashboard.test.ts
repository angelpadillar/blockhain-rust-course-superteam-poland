import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "playwright-core";
import {
  createCardOn,
  freezeCardOn,
  readBalanceFrom,
} from "../src/altitude/commands.js";

test(
  "Altitude dashboard flows work against the observed fixture",
  { skip: !process.env.ALTITUDE_BROWSER_EXECUTABLE },
  async () => {
    const executablePath = process.env.ALTITUDE_BROWSER_EXECUTABLE;
    if (!executablePath) return;
    const browser = await chromium.launch({
      executablePath,
      headless: true,
    });
    try {
      const page = await browser.newPage();
      const fixturePath = fileURLToPath(
        new URL("./fixtures/altitude-dashboard.html", import.meta.url),
      );
      await page.goto(`file://${fixturePath}`, {
        waitUntil: "domcontentloaded",
      });
      const screenshot = async (name: string): Promise<string> => name;
      const balance = await readBalanceFrom(page, { screenshot });
      assert.equal(balance.spendable_usd, 10.81);
      assert.equal(balance.cards.length, 3);

      const request = {
        command: "create" as const,
        reference: "fixture-card-dry-run",
        amountUsd: 50,
      };
      const previousLiveOps = process.env.ALTITUDE_LIVE_CARD_OPS;
      delete process.env.ALTITUDE_LIVE_CARD_OPS;
      const dryRun = await createCardOn(page, request, {
        screenshot,
        cardholderEmail: "fulfillment-demo@example.com",
      });
      assert.equal(dryRun.status, "dry_run");
      assert.equal(dryRun.ok, true);
      assert.equal(dryRun.card?.last4, "");
      assert.equal(
        await page
          .getByText("Issue a new virtual card", { exact: true })
          .isVisible(),
        false,
      );

      process.env.ALTITUDE_LIVE_CARD_OPS = "1";
      const live = await createCardOn(
        page,
        { ...request, reference: "fixture-card-live" },
        {
          screenshot,
          cardholderEmail: "fulfillment-demo@example.com",
        },
      );
      assert.equal(live.status, "live");
      assert.equal(live.ok, true);
      assert.equal(live.card?.last4, "9243");
      const frozen = await freezeCardOn(page, "fixture-card-live", {
        screenshot,
        live: true,
      });
      assert.equal(frozen.ok, true);
      assert.equal(frozen.card?.status, "Frozen");
      if (previousLiveOps === undefined) {
        delete process.env.ALTITUDE_LIVE_CARD_OPS;
      } else {
        process.env.ALTITUDE_LIVE_CARD_OPS = previousLiveOps;
      }
    } finally {
      await browser.close();
    }
  },
);
