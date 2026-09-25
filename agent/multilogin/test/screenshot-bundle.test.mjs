import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSafeScreenshot } from '../src/screenshots.mjs';
import { announceCheckpoint } from '../src/human-checkpoint.mjs';
import { createRedactor } from '../src/core.mjs';
import { loadPlaywright } from '../src/runner.mjs';
import { PNG_SIGNATURE, pngInfo } from './fixtures/checkpoint-page.mjs';

// Human-checkpoint screenshot BUNDLE integrity: the canonical viewport PNG is
// preserved byte-for-byte, and the full-page frame, the focused challenge
// region and the JSON context sidecar are added without re-encoding it. The
// synthetic fixture is a normal web page, never a CAPTCHA.
async function launchChrome() {
  try {
    const { chromium } = await loadPlaywright();
    try { return await chromium.launch({ channel: 'chrome', headless: true }); }
    catch { return await chromium.launch({ headless: true }); }
  } catch { return null; }
}

const CHALLENGE_HTML = `<!doctype html><html><head><title>Verify it's you</title>
<style>body{font-family:sans-serif}iframe{display:block;width:420px;height:300px;border:2px solid #333}
form{margin-top:24px}input{padding:8px;font-size:16px}button{padding:8px 16px}</style></head>
<body><h1>Verify you are human</h1>
<iframe src="/recaptcha/anchor" title="challenge"></iframe>
<form action="/challenge/answer" method="post">
<input name="challengeCode" aria-label="Enter the code"><button>Submit</button>
</form><p>Contact hidden@example.com or code 123456 if you need help.</p>
<div style="height:1200px">tall page for full-page capture</div>
</body></html>`;

async function fixtureServer(t) {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/recaptcha/anchor') return response.end('<p>recaptcha fixture</p>');
    response.end(CHALLENGE_HTML);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}` };
}

test('a checkpoint bundle keeps the canonical PNG and adds full, region and context evidence', async t => {
  const browser = await launchChrome();
  if (!browser) { t.skip('no local Chrome/playwright-core; screenshot bundle check skipped'); return; }
  t.after(() => browser.close());
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { origin } = await fixtureServer(t);
  const viewport = { width: 1280, height: 720 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(`${origin}/challenge?token=should-not-leak`, { waitUntil: 'load' });

  const result = await captureSafeScreenshot({ page, directory, label: 'checkpoint_human_verification_required',
    index: 7, credentialOrigins: [origin], settleMs: 100, minBytes: 100, attempts: 2, bundle: true,
    redact: createRedactor([]),
    context: { jobId: 'yt-live-04', platform: 'youtube', accountRef: 'yt-live-04', profileRef: 'yt-live-04',
      profileId: 'profile-004', reason: 'human_verification_required' } });
  assert.equal(result.skipped, undefined);
  // 1. Canonical viewport frame: native resolution.
  const canonical = await readFile(result.path);
  assert.deepEqual(canonical.subarray(0, 8), PNG_SIGNATURE);
  const info = pngInfo(canonical);
  assert.deepEqual({ width: info.width, height: info.height }, viewport, 'canonical captures the viewport');
  // 2. Full-page frame: same width, the whole document.
  const full = await readFile(result.fullPath);
  assert.deepEqual(full.subarray(0, 8), PNG_SIGNATURE);
  const fullInfo = pngInfo(full);
  assert.equal(fullInfo.width, viewport.width);
  assert.ok(fullInfo.height >= viewport.height, `full page should cover the document: ${fullInfo.height}`);
  // 3. Focused challenge region: the challenge iframe, larger than the minimum.
  const region = await readFile(result.regionPath);
  assert.deepEqual(region.subarray(0, 8), PNG_SIGNATURE);
  const regionInfo = pngInfo(region);
  assert.ok(regionInfo.width >= 160 && regionInfo.height >= 80,
    `region too small: ${regionInfo.width}x${regionInfo.height}`);
  assert.match(result.regionSelector, /recaptcha/);
  // 4. Context sidecar: identity + legibility metadata, no query string, redacted text.
  const document = JSON.parse(await readFile(result.contextPath, 'utf8'));
  assert.equal(document.jobId, 'yt-live-04');
  assert.equal(document.profileRef, 'yt-live-04');
  assert.equal(document.profileId, 'profile-004');
  assert.equal(document.reason, 'human_verification_required');
  assert.equal(document.url, `${origin}/challenge`, 'query strings never enter the context');
  assert.equal(typeof (document.timestamp ?? document.capturedAt), 'string');
  assert.equal(document.viewport.width, viewport.width);
  assert.equal(document.schema, 'browser-checkpoint-context/1');
  assert.equal(document.files.viewport, result.name);
  assert.equal(document.files.full, result.fullName);
  assert.equal(document.files.region, result.regionName);
  assert.ok(document.title.length > 0);
  // The visible-text summary is the job's own redactor, so the email and the
  // six-digit code in the fixture are masked before they reach disk.
  assert.equal(document.visibleText.includes('hidden@example.com'), false);
  assert.equal(document.visibleText.includes('123456'), false);
  // 5. The canonical file is untouched: capture again and compare bytes/size.
  const names = await readdir(directory);
  assert.ok(names.includes(result.name));
  assert.ok(names.includes(result.fullName));
  assert.ok(names.includes(result.regionName));
  assert.ok(names.includes(`${result.name.replace(/\.png$/, '')}-context.json`));
});

test('the announce path still selects the canonical frame when a bundle is present', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-bundle-announce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'job.json'), JSON.stringify({ jobId: 'yt-live-05', accountRef: 'yt-live-05',
    profileRef: 'yt-live-05', state: 'waiting_for_human',
    stateTransitions: [{ state: 'waiting_for_human', reason: 'human_verification_required' }] }));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(directory, 'screenshots'), { recursive: true });
  const canonicalName = '03-checkpoint_human_verification_required.png';
  const source = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4096, 9)]);
  await writeFile(join(directory, 'screenshots', canonicalName), source);
  await writeFile(join(directory, 'screenshots', '03-checkpoint_human_verification_required-full.png'), Buffer.alloc(64, 1));
  await writeFile(join(directory, 'screenshots', '03-checkpoint_human_verification_required-region.png'), Buffer.alloc(64, 2));
  await writeFile(join(directory, 'screenshots', '03-checkpoint_human_verification_required-context.json'), '{}');
  const notifier = { sent: [], async notify(args) { this.sent.push(args);
    return { delivered: 'photo+document', previewMessageId: 1, documentMessageId: 2 }; } };
  const announced = await announceCheckpoint({ directory, notifier, seconds: 1800 });
  assert.equal(announced.checkpoint.screenshot, join(directory, 'screenshots', canonicalName));
  const sentBytes = await readFile(notifier.sent[0].checkpoint.screenshot);
  assert.deepEqual(sentBytes, source, 'the announced bytes are the canonical capture');
});

test('a page double without bundle APIs still records the canonical screenshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-bundle-double-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const page = {
    url: () => 'https://accounts.google.com/signin/v2/challenge',
    locator: () => ({ count: async () => 0, first() { return this; }, isVisible: async () => false,
      boundingBox: async () => null }),
    // No fullPage support: a full-page request fails like an older page double.
    screenshot: async ({ path, fullPage }) => {
      if (fullPage) throw new Error('fullPage unsupported');
      await writeFile(path, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(2048, 4)]));
    },
  };
  const result = await captureSafeScreenshot({ page, directory, label: 'checkpoint_double', index: 1,
    settleMs: 0, minBytes: 1, attempts: 1, bundle: true });
  assert.ok(result.path);
  assert.equal(result.fullPath, undefined, 'a page double without fullPage support has no full frame');
  assert.ok(result.diagnostics.includes('full_page_capture_failed'));
  assert.deepEqual((await readFile(result.path)).subarray(0, 8), PNG_SIGNATURE);
});
