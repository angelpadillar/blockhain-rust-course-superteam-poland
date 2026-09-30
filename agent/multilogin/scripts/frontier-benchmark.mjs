// G1/G2 live benchmark: the SAME screenshot, prompt, permitted actions and model,
// run twice through the real FireworksVisionAdvisor adapter:
//
//   A: image + constrained function calling (tool_choice)
//   B: image + structured JSON response (response_format json_object)
//
// It records success, latency, provider usage (prompt/cached/completion tokens),
// requestId and the calculated USD per call into the real frontier ledger. Prompt
// contents and image bytes are never persisted.
//
//   node scripts/frontier-benchmark.mjs [--secret PATH] [--pricing PATH] [--ledger DIR]
import { deflateSync } from 'node:zlib';
import { errorCode } from '../src/core.mjs';
import { createFireworksVision, defaultFireworksSecretPath } from '../src/frontier.mjs';
import { createFrontierLedger, summarizeFrontierMetrics } from '../src/frontier-ledger.mjs';
import { estimatedUsd, loadPricing, mapUsage } from '../src/pricing.mjs';

const flag = (argv, name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

let crcTable = null;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A tiny checkerboard PNG built in-process: the smallest honest screenshot.
function checkerboardPng(width = 240, height = 140) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < width; x++) {
      const value = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? 255 : 200;
      raw[offset++] = value; raw[offset++] = value; raw[offset++] = value;
    }
  }
  const chunk = (tag, data) => {
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const observation = {
  epoch: 'benchmark-epoch-1',
  url: { origin: 'https://www.youtube.com', pathname: '/' },
  text: 'Recommended videos 12:04  Two controls are visible.',
  controls: [{ id: 'e0', role: 'button', name: 'Account menu', enabled: true },
    { id: 'e1', role: 'button', name: 'Skip', enabled: true }],
};
const permittedActions = [
  { id: 'a0', description: 'open_account_menu: click the observed account menu control', kind: 'click' },
  { id: 'a1', description: 'dismiss_onboarding: click the observed skip control', kind: 'dismiss' },
];
const goal = 'Verify the signed-in account identity. Two permitted actions are offered: a0 opens the '
  + 'account menu, a1 dismisses an onboarding dialog. Choose the one the image supports.';

async function run(mode, { secretPath, pricingPath, ledger, timeoutMs }) {
  const png = checkerboardPng();
  const screenshot = { base64: png.toString('base64'), width: 240, height: 140, bytes: png.length,
    name: 'benchmark.png' };
  const captured = [];
  const recording = { path: ledger.path, async record(metric) { captured.push(metric); return ledger.record(metric); } };
  const vision = createFireworksVision({ secretPath, pricingPath, ledger: recording, mode, timeoutMs,
    capture: async () => screenshot });
  const started = Date.now();
  try {
    const decision = await vision.decide({ goal, operation: 'open_account_menu', observation,
      permittedActions, trigger: 'visual_only_ui', screenshot });
    return { mode, ok: true, latencyMs: Date.now() - started, decision, metric: captured[0] || null };
  } catch (error) {
    return { mode, ok: false, latencyMs: Date.now() - started, error: errorCode(error),
      detail: error?.detail ?? null, metric: captured[0] || null };
  }
}

const argv = process.argv.slice(2);
const secretPath = flag(argv, 'secret', defaultFireworksSecretPath);
const pricingPath = flag(argv, 'pricing', null);
const ledgerDirectory = flag(argv, 'ledger', '/opt/buena-multilogin/private/frontier-ledger');
const timeoutMs = Number(flag(argv, 'timeout', '90')) * 1000;
const ledger = createFrontierLedger({ directory: ledgerDirectory });
const { pricing } = await loadPricing({ path: pricingPath });

const results = [];
for (const mode of ['tool', 'json']) {
  results.push(await run(mode, { secretPath, pricingPath, ledger, timeoutMs }));
  await new Promise(resolve => setTimeout(resolve, 1500));
}

const lastTwo = results.map(result => result.metric).filter(Boolean);
const decorated = results.map(result => {
  const metric = result.metric || {};
  const usage = mapUsage({ prompt_tokens: (metric.uncachedInputTokens ?? 0) + (metric.cachedInputTokens ?? 0),
    completion_tokens: metric.outputTokens, prompt_tokens_details: { cached_tokens: metric.cachedInputTokens } });
  return { mode: result.mode, ok: result.ok, error: result.error ?? null, detail: result.detail ?? null,
    latencyMs: result.latencyMs, requestId: metric.requestId ?? null,
    promptTokens: metric.uncachedInputTokens === null || metric.uncachedInputTokens === undefined
      ? null : metric.uncachedInputTokens + (metric.cachedInputTokens ?? 0),
    cachedTokens: metric.cachedInputTokens ?? null, outputTokens: metric.outputTokens ?? null,
    estimatedUsd: metric.estimatedUsd ?? (usage.available ? estimatedUsd(usage, pricing) : null),
    decision: result.decision ?? null };
});

console.log(JSON.stringify({
  model: 'accounts/fireworks/models/deepseek-v4p1-flash',
  pricing: { ...pricing },
  ledger: ledger.path,
  results: decorated,
  summary: summarizeFrontierMetrics(lastTwo, { jobs: 1, completedTasks: 1 }),
}, null, 2));
