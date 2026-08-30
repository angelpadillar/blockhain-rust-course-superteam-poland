import { verifyConfirmation } from "./browser.js";
import { loadConfig, loadRuntimeOptions, renderNote } from "./config.js";
import { readJson, writeJson } from "./files.js";
import {
  type McpBrowserObservation,
  validateMcpBrowserObservation,
} from "./mcp-observation.js";

const config = loadConfig();
const options = loadRuntimeOptions();
const note = renderNote(config.note, options.nonce);
verifyConfirmation(config, options, note);

const observed = readJson<McpBrowserObservation>(
  "mcp-browser-observation.json",
);
const quote = validateMcpBrowserObservation(
  config,
  note,
  observed,
  new Date(Date.now() - 10 * 60_000),
);
writeJson("quote.json", quote);
writeJson("last-run.json", {
  status: "stopped_before_payment",
  driver: "mcp_visual",
  amount_pln: quote.landed_pln,
  ts: new Date().toISOString(),
});
console.log(
  `MCP quote verified: ${quote.landed_pln?.toFixed(2)} PLN <= ${config.max_pln.toFixed(2)} PLN.`,
);
console.log("STOPPED BEFORE PAYMENT METHOD");
