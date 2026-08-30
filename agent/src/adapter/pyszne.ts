import type { AgentConfig, RuntimeOptions } from "../types.js";
import { BrowserFoodAdapter, PYSZNE_SITE } from "./browser_food.js";

export class PyszneAdapter extends BrowserFoodAdapter {
  constructor(config: AgentConfig, options: RuntimeOptions, note: string) {
    super(PYSZNE_SITE, config, options, note);
  }
}
