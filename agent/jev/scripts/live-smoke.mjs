import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { config, job } from '../tests/helpers.mjs';
import { fixture } from '../tests/store-fixture.mjs';
import { runShopping } from '../src/runner.mjs';
import { createJev } from '../src/jev.mjs';
import { openBrowser } from '../src/glovo.mjs';

let apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey && process.stdin.isTTY) {
  process.stdout.write('Typesafe key (hidden): '); process.stdin.setRawMode(true); process.stdin.resume();
  apiKey = await new Promise(resolve => {
    let text = '';
    const read = data => {
      text += data.toString();
      if (/[\r\n]/.test(text)) { process.stdin.off('data', read); resolve(text.trim()); }
    };
    process.stdin.on('data', read);
  });
  process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
}
const store = await fixture(), dataDir = await mkdtemp(tmpdir() + '/jev-live-smoke-');
try {
  const cfg = { ...config, storeUrl: store.url, maxSteps: 6, maxRunMs: 45000 };
  const result = await runShopping({ id: 'live-jev-local-shop', job, config: cfg,
    signal: new AbortController().signal, open: () => openBrowser({ dataDir, config: cfg }),
    decide: createJev({ apiKey, model: cfg.model }) });
  const report = { test: 'Real Jev API + real Playwright + controlled local shop; not a live Glovo measurement',
    capturedAt: new Date().toISOString(), ordersSubmitted: store.orders(), ...result };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/live-smoke.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (result.status !== 'ready_for_review' || store.orders()) process.exitCode = 1;
} finally { apiKey = null; await store.close(); await rm(dataDir, { recursive: true, force: true }); }
