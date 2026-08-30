import type { AgentConfig, RuntimeOptions } from "../types.js";
import { LocalPrintAdapter } from "./local_print.js";
import { ManualAdapter } from "./manual.js";
import type { FulfillmentAdapter } from "./types.js";
import { GlovoAdapter } from "./glovo.js";
import { PyszneAdapter } from "./pyszne.js";
import { WoltAdapter } from "./wolt.js";

function createAdapter(
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): FulfillmentAdapter {
  if (config.adapter === "wolt") return new WoltAdapter(config, options, note);
  if (config.adapter === "glovo")
    return new GlovoAdapter(config, options, note);
  if (config.adapter === "pyszne")
    return new PyszneAdapter(config, options, note);
  if (config.adapter === "local_print")
    return new LocalPrintAdapter(config, options, note);
  return new ManualAdapter(config, options, note);
}

export async function runFulfillmentAdapter(
  config: AgentConfig,
  options: RuntimeOptions,
  note: string,
): Promise<void> {
  const adapter = createAdapter(config, options, note);
  try {
    await adapter.searchOrOpen();
    await adapter.buildCartOrOrderForm();
    await adapter.fillDestination();
    await adapter.attachNote();
    await adapter.quote();
    await adapter.stopAtPaywall();
    if (options.allowPay && adapter.pay) await adapter.pay();
  } finally {
    await adapter.close();
  }
}
