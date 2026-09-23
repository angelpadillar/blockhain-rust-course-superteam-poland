import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSafeScreenshot } from '../src/screenshots.mjs';
import { createTelegramNotifier } from '../src/human-checkpoint.mjs';
import { loadPlaywright } from '../src/runner.mjs';
import { BLANK_HTML, FIXTURE_HTML, PNG_SIGNATURE, VIEWPORT, pngInfo, sha256 }
  from './fixtures/checkpoint-page.mjs';

// Human-checkpoint screenshot fidelity. Two questions are answered here:
//   1. is the SOURCE frame a native-resolution, legible PNG? (the capture path)
//   2. does the operator receive those exact bytes, or a recompressed copy?
// The synthetic fixture below is a normal web page, never a CAPTCHA, and no
// browser starts unless a local Chrome is available.

async function launchChrome() {
  try {
    const { chromium } = await loadPlaywright();
    try { return await chromium.launch({ channel: 'chrome', headless: true }); }
    catch { return await chromium.launch({ headless: true }); }
  } catch { return null; }
}

async function captureHtml(browser, html, directory, label) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    return await captureSafeScreenshot({ page, directory, label, index: 1, credentialOrigins: [],
      settleMs: 100, minBytes: 8000, attempts: 3 });
  } finally { await context.close(); }
}

test('the source checkpoint frame is a native-resolution, legible PNG', async t => {
  const browser = await launchChrome();
  if (!browser) { t.skip('no local Chrome/playwright-core; capture-fidelity browser check skipped'); return; }
  t.after(() => browser.close());
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-fidelity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const fixture = await captureHtml(browser, FIXTURE_HTML, directory, 'checkpoint_human_verification_required');
  const blank = await captureHtml(browser, BLANK_HTML, directory, 'blank_frame');

  const fixtureBytes = await readFile(fixture.path);
  const blankBytes = await readFile(blank.path);
  assert.deepEqual(fixtureBytes.subarray(0, 8), PNG_SIGNATURE, 'the source capture is a PNG');
  const info = pngInfo(fixtureBytes);
  const hash = sha256(fixtureBytes);

  // Native viewport, not a thumbnail: the dimensions equal the browser viewport.
  assert.deepEqual({ width: info.width, height: info.height },
    { width: VIEWPORT.width, height: VIEWPORT.height }, 'the viewport is captured at native resolution');
  assert.equal(info.bitDepth, 8);
  // A legible frame carries real detail, so it is substantially larger than a
  // blank frame of the same size, and it clears the checkpoint capture floor.
  assert.equal(fixtureBytes.length >= 8000, true, `fixture PNG too small: ${fixtureBytes.length}`);
  assert.equal(fixtureBytes.length > blankBytes.length * 4, true,
    `fixture ${fixtureBytes.length} vs blank ${blankBytes.length}: the frame carries real detail`);
  assert.equal(fixture.attempts, 1, 'a fully painted first frame is captured on the first attempt');
  assert.match(hash, /^[0-9a-f]{64}$/);
  // The metadata the diagnostic report quotes.
  assert.deepEqual({ format: 'png', width: info.width, height: info.height },
    { format: 'png', width: 1280, height: 720 });
});

test('a blank or half-painted frame is retried a bounded number of times', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-settle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // A deterministic page double that stays blank for two frames and then paints.
  const makePage = sizes => {
    const state = { calls: 0 };
    return { state,
      url: () => 'https://accounts.google.com/signin/v2/challenge',
      locator: () => ({ count: async () => 0 }),
      evaluate: async () => {},
      waitForTimeout: async () => {},
      screenshot: async ({ path }) => {
        const size = sizes[Math.min(state.calls, sizes.length - 1)]; state.calls++;
        await writeFile(path, Buffer.alloc(size, 7));
      } };
  };

  const repaints = makePage([900, 900, 9000]);
  const result = await captureSafeScreenshot({ page: repaints, directory, label: 'checkpoint_retry',
    index: 1, settleMs: 50, minBytes: 8000, attempts: 3 });
  assert.equal(result.bytes, 9000);
  assert.equal(result.attempts, 3, 'the painted frame is captured on the third attempt');
  assert.equal(repaints.state.calls, 3);

  // A genuinely sparse-but-real page is still recorded rather than discarded.
  const sparse = makePage([900]);
  const kept = await captureSafeScreenshot({ page: sparse, directory, label: 'checkpoint_sparse',
    index: 2, settleMs: 50, minBytes: 8000, attempts: 3 });
  assert.equal(kept.bytes, 900);
  assert.equal(kept.attempts, 3);
  assert.equal(sparse.state.calls, 3);

  // The retry budget is finite and capped.
  const capped = makePage([1]);
  await captureSafeScreenshot({ page: capped, directory, label: 'checkpoint_capped', index: 3,
    settleMs: 1, minBytes: 8000, attempts: 99 });
  assert.equal(capped.state.calls <= 5, true, 'attempts are capped at five');
});

function telegramFetch({ documentFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const method = url.split('/').pop();
    calls.push({ method, form: options.body });
    if (method === 'sendDocument' && documentFails) throw new Error('network_down');
    if (method === 'sendPhoto') {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 11,
        photo: [{ file_id: 'photo-small', file_size: 9 }, { file_id: 'photo-largest', file_size: 99 }] } }) };
    }
    if (method === 'sendDocument') {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 12,
        document: { file_id: 'doc-1' } } }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 13 } }) };
  };
  return { calls, fetchImpl };
}

async function secrets(t) {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-fidelity-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { tokenPath: join(directory, 'telegram-bot-token'),
    chatIdPath: join(directory, 'telegram-allowed-chat-id'),
    userIdPath: join(directory, 'telegram-allowed-user-id') };
  await writeFile(paths.tokenPath, 'bot-fixture-token\n', { mode: 0o600 });
  await writeFile(paths.chatIdPath, '4242\n', { mode: 0o600 });
  await writeFile(paths.userIdPath, '77\n', { mode: 0o600 });
  return paths;
}

const checkpointFor = screenshotPath => ({ id: '0d4f3feb-1f3a-4578-8964-e0a91f8497c1',
  jobId: 'youtube-live-fixture', accountRef: 'yt-live-05', origin: 'https://accounts.google.com',
  reason: 'human_verification_required', expiresAt: '2026-09-22T21:49:35.981Z', screenshot: screenshotPath });


test('the notifier sends the photo preview and the untouched original PNG document', async t => {
  const paths = await secrets(t);
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-fidelity-send-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const screenshotPath = join(directory, '02-checkpoint_human_verification_required.png');
  const source = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4096, 3)]);
  await writeFile(screenshotPath, source, { mode: 0o600 });

  const session = telegramFetch();
  const notifier = createTelegramNotifier({ ...paths, fetchImpl: session.fetchImpl });
  const delivery = await notifier.notify({ checkpoint: checkpointFor(screenshotPath) });

  assert.deepEqual(session.calls.map(call => call.method), ['sendPhoto', 'sendDocument'],
    'the preview is sent first, then the original as a document');
  assert.equal(delivery.delivered, 'photo+document');
  assert.equal(delivery.previewMessageId, 11);
  assert.equal(delivery.documentMessageId, 12);
  assert.equal(delivery.photoFileId, 'photo-largest');
  assert.equal(delivery.documentFileId, 'doc-1');
  assert.equal(delivery.documentName, '02-checkpoint_human_verification_required.png');

  const preview = session.calls[0].form;
  const document = session.calls[1].form;
  assert.equal(preview.get('chat_id'), '4242');
  assert.equal(document.get('chat_id'), '4242');
  assert.equal(document.get('document').name, '02-checkpoint_human_verification_required.png',
    'the document keeps the source filename');
  assert.deepEqual(Buffer.from(await document.get('document').arrayBuffer()), source,
    'the document bytes are the source bytes, not a resized/recompressed copy');
  assert.deepEqual(Buffer.from(await preview.get('photo').arrayBuffer()), source);
  const caption = preview.get('caption');
  assert.equal(caption.includes('checkpoint'), true);
  assert.equal(caption.includes('bot-fixture-token'), false, 'never the token');
});

test('a document failure still delivers the preview, and it is reported', async t => {
  const paths = await secrets(t);
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-fidelity-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const screenshotPath = join(directory, 'checkpoint.png');
  await writeFile(screenshotPath, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(1024, 1)]), { mode: 0o600 });

  const session = telegramFetch({ documentFails: true });
  const notifier = createTelegramNotifier({ ...paths, fetchImpl: session.fetchImpl });
  const delivery = await notifier.notify({ checkpoint: checkpointFor(screenshotPath) });

  assert.deepEqual(session.calls.map(call => call.method), ['sendPhoto', 'sendDocument']);
  assert.equal(delivery.delivered, 'photo', 'the alert is not lost because the document failed');
  assert.equal(delivery.previewMessageId, 11);
  assert.equal(delivery.documentMessageId, null);
  assert.equal(typeof delivery.documentError, 'string');
  assert.equal(notifier.diagnostics.documentFailures, 1);

  // Opting out of the document sends exactly one message; no screenshot still
  // falls back to the text alert.
  const photoOnly = telegramFetch();
  const photoNotifier = createTelegramNotifier({ ...paths, fetchImpl: photoOnly.fetchImpl });
  const single = await photoNotifier.notify({ checkpoint: checkpointFor(screenshotPath), sendOriginal: false });
  assert.deepEqual(photoOnly.calls.map(call => call.method), ['sendPhoto']);
  assert.equal(single.delivered, 'photo');

  const noShot = telegramFetch();
  const textNotifier = createTelegramNotifier({ ...paths, fetchImpl: noShot.fetchImpl });
  const textOnly = await textNotifier.notify({ checkpoint: checkpointFor(join(directory, 'absent.png')) });
  assert.deepEqual(noShot.calls.map(call => call.method), ['sendMessage']);
  assert.equal(textOnly.delivered, 'text');
});

