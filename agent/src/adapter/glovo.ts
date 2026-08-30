import type { AgentConfig, RuntimeOptions } from "../types.js";
import { BrowserFoodAdapter, GLOVO_SITE } from "./browser_food.js";

export class GlovoAdapter extends BrowserFoodAdapter {
  constructor(config: AgentConfig, options: RuntimeOptions, note: string) {
    super(GLOVO_SITE, config, options, note);
  }
}
