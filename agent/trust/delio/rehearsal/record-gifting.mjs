// Records the existing local application in a fresh, isolated test browser.
// No user browser/profile, external site, real merchant, wallet or paid API.
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(here, '../../..');
const require = createRequire(import.meta.url);
const { chromium } = require(join(workspace, 'hackathon/jev/node_modules/playwright-core'));
const output = resolve(process.argv[2] ?? join(workspace, 'checkpoints/gifting-2026-09-19/recording'));
const origin = 'http://127.0.0.1:4318';
await mkdir(join(output, 'frames'), { recursive: true, mode: 0o700 });
const browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
const page = await context.newPage();
page.setDefaultTimeout(30_000);
await page.goto(origin);
const frames = [], moments = [], receipts = [];
let recording = true, captureError;
const began = performance.now();
const wait = ms => new Promise(r => setTimeout(r, ms));
const ready = () => page.waitForFunction(() => document.querySelector('main')?.getAttribute('aria-busy') === 'false');
async function moment(name) {
  moments.push({ name, atSeconds: (performance.now() - began) / 1000 });
  await wait(1600);
}
async function click(selector) {
  await page.locator(selector).scrollIntoViewIfNeeded();
  await wait(500);
  await page.locator(selector).click();
  await ready();
}
async function receipt(name) {
  const data = await page.evaluate(async () => (await fetch('/api/evidence')).json());
  const file = `${name}-receipt.json`;
  await writeFile(join(output, file), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  receipts.push({ name, file, phase: data.phase, runId: data.runId,
    verified: data.verification?.ok ?? false, dispatchCount: data.execution?.dispatchCount,
    campaignStatus: data.chain?.accountState?.campaign?.status });
  return data;
}
const capture = (async () => {
  while (recording) {
    const file = `frame-${String(frames.length).padStart(5, '0')}.jpg`;
    const at = (performance.now() - began) / 1000;
    try {
      await page.screenshot({ path: join(output, 'frames', file), type: 'jpeg', quality: 82 });
      frames.push({ file, at });
    } catch (e) { captureError = e.message; break; }
    await wait(160);
  }
})();
let failure;
try {
  await ready();
  await page.getByRole('button', { name: /Approve exactly 129 PLN/ }).waitFor();
  await moment('Fictional gift, local LiteSVM, no real wallet or merchant');
  await click('[data-command="approve"]');
  await moment('Exact PLN 129 local authorization confirmed');
  await click('[data-command="execute"]');
  let state = await receipt('happy');
  if (state.phase !== 'completed' || state.verification?.ok !== true || state.execution.dispatchCount !== 1) throw new Error('happy_path_not_verified');
  await moment('Simulated gift verified');
  await click('[data-command="execute"]');
  await moment('Fresh transaction replay rejected, original order retained');
  await receipt('replay');
  await page.locator('#evidence-heading').scrollIntoViewIfNeeded();
  await moment('Independent checks and local transaction evidence');

  await click('[data-scenario="price_change"]');
  await click('[data-command="approve"]');
  await moment('Approved PLN 129, current checkout PLN 149');
  await click('[data-command="execute"]');
  state = await receipt('price-change');
  if (state.phase !== 'blocked' || state.execution.dispatchCount !== 0) throw new Error('changed_price_not_blocked');
  await moment('Price change stopped before any merchant dispatch');

  await click('[data-scenario="uncertain"]');
  await click('[data-command="approve"]');
  await click('[data-command="execute"]');
  state = await receipt('uncertain');
  if (state.phase !== 'needs_reconciliation' || state.execution.dispatchCount !== 1) throw new Error('uncertain_state_missing');
  await moment('Missing reply: reconcile the existing order');
  await click('[data-command="reconcile"]');
  state = await receipt('reconciled');
  if (state.phase !== 'completed' || state.verification?.ok !== true || state.execution.dispatchCount !== 1) throw new Error('reconciliation_not_verified');
  await moment('Existing simulated order verified without a second dispatch');
  await page.locator('.environment-bar').scrollIntoViewIfNeeded();
  await moment('Local prototype and simulated merchant labels');
} catch (e) { failure = e.message; }
finally {
  recording = false;
  await capture;
  await context.close();
  await browser.close();
}
if (frames.length) {
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    lines.push(`file 'frames/${frames[i].file}'`, `duration ${Math.max(.04, (frames[i + 1]?.at ?? frames[i].at + .2) - frames[i].at).toFixed(6)}`);
  }
  lines.push(`file 'frames/${frames.at(-1).file}'`);
  await writeFile(join(output, 'frames.ffconcat'), `${lines.join('\n')}\n`);
  await new Promise((resolve, reject) => {
    const p = spawn('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '1', '-i', 'frames.ffconcat',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr', '-movflags', '+faststart', 'gifting-local-demo.mp4'],
    { cwd: output, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; p.stderr.on('data', b => { error += b; }); p.on('error', reject); p.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  });
}
const video = await readFile(join(output, 'gifting-local-demo.mp4'));
const report = { recordedAt: new Date().toISOString(), origin, isolatedBrowser: true, realPayments: false, liveMerchant: false,
  chainBackend: 'LiteSVM local Solana', fictionalRecipient: true, uneditedApp: true, capture: 'actual browser screenshots at original elapsed times, no synthetic frames or added labels',
  frames: frames.length, moments, receipts, failure: failure ?? captureError ?? null,
  video: { file: 'gifting-local-demo.mp4', sha256: createHash('sha256').update(video).digest('hex'), bytes: video.length } };
await writeFile(join(output, 'recording.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ output, frames: frames.length, receipts, failure: report.failure, video: report.video })}\n`);
if (report.failure) process.exitCode = 1;
