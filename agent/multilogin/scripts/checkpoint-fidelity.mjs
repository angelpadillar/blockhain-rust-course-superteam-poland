// Checkpoint screenshot fidelity diagnostic (STEP A).
//
// It answers one question with evidence: is a poor Telegram checkpoint image lost
// in the CAPTURE, in the TELEGRAM PHOTO transport, or nowhere?
//
//   node scripts/checkpoint-fidelity.mjs capture --out DIR
//   node scripts/checkpoint-fidelity.mjs send --png PATH [--job-id ID]
//   node scripts/checkpoint-fidelity.mjs all --out DIR
//
// `capture` renders a synthetic, offline fixture page through the SAME capture
// function the job path uses (captureSafeScreenshot) and records the source PNG
// metadata. `send` pushes that exact file through the existing notifier
// (sendPhoto preview + sendDocument original), then retrieves both transmitted
// files through the Bot API and compares dimensions, bytes and SHA-256.
//
// Nothing here is a CAPTCHA and nothing touches an account.
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { captureSafeScreenshot } from '../src/screenshots.mjs';
import { loadPlaywright } from '../src/runner.mjs';
import { createCheckpoint, createTelegramNotifier, defaultTelegramTokenPath } from '../src/human-checkpoint.mjs';
import { loadSecret } from '../src/frontier.mjs';
import { errorCode } from '../src/core.mjs';
import { FIXTURE_HTML, VIEWPORT, pngInfo, sha256 } from '../test/fixtures/checkpoint-page.mjs';

const flag = (argv, name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

async function capture({ directory, label = 'checkpoint_human_verification_required' }) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.setContent(FIXTURE_HTML, { waitUntil: 'load' });
    const shot = await captureSafeScreenshot({ page, directory, label, index: 1, credentialOrigins: [],
      settleMs: 100, minBytes: 8000, attempts: 3 });
    await chmod(shot.path, 0o600);
    const bytes = await readFile(shot.path);
    const info = pngInfo(bytes);
    return { step: 'source_capture', path: shot.path, attempts: shot.attempts ?? null,
      format: 'png', width: info?.width ?? null, height: info?.height ?? null,
      bytes: bytes.length, sha256: sha256(bytes) };
  } finally { await context.close(); await browser.close(); }
}

// Telegram stores a photo re-encoded (and possibly resized); a document is kept
// verbatim. Both are fetched back for the comparison.
function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset++; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function describe(buffer) {
  const png = pngInfo(buffer);
  if (png) return { format: 'png', width: png.width, height: png.height, bytes: buffer.length,
    sha256: sha256(buffer) };
  const jpeg = jpegSize(buffer);
  if (jpeg) return { format: 'jpeg', width: jpeg.width, height: jpeg.height, bytes: buffer.length,
    sha256: sha256(buffer) };
  return { format: 'unknown', width: null, height: null, bytes: buffer.length, sha256: sha256(buffer) };
}

async function send({ png, jobId = 'checkpoint-fidelity-synthetic' }) {
  const notifier = createTelegramNotifier();
  const status = await notifier.status();
  if (status.state !== 'available') return { step: 'send', sent: false, reason: status.code };
  const checkpoint = createCheckpoint({ jobId, accountRef: 'synthetic-fixture-page',
    profileRef: 'synthetic-fixture-page', origin: 'https://fixture.invalid',
    reason: 'human_verification_required', seconds: 600, screenshotPath: png });
  const delivery = await notifier.notify({ checkpoint });
  const source = describe(await readFile(png));

  // Retrieve what Telegram actually stored, through the Bot API.
  const token = (await loadSecret(defaultTelegramTokenPath)).value;
  const fetchFile = async fileId => {
    if (!fileId) return null;
    const info = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
      .then(response => response.json()).catch(() => null);
    const filePath = info?.result?.file_path;
    if (!filePath) return null;
    const buffer = Buffer.from(await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`)
      .then(response => response.arrayBuffer()));
    return { filePath, ...describe(buffer) };
  };
  const photo = await fetchFile(delivery.photoFileId);
  const document = await fetchFile(delivery.documentFileId);

  const photoAltered = !!(photo && (photo.sha256 !== source.sha256 || photo.bytes !== source.bytes
    || photo.width !== source.width || photo.height !== source.height));
  const documentExact = !!(document && document.sha256 === source.sha256 && document.bytes === source.bytes);
  const captureSound = source.format === 'png' && (source.width ?? 0) >= 640 && source.bytes >= 8000;
  const verdict = !captureSound ? 'capture bad'
    : photoAltered && documentExact
      ? 'Telegram photo compression bad; the original document preserves the source'
      : photoAltered ? 'both' : 'neither / prior issue not reproduced';
  return { step: 'send', sent: true, checkpointId: checkpoint.id,
    previewMessageId: delivery.previewMessageId, documentMessageId: delivery.documentMessageId,
    documentName: delivery.documentName, delivered: delivery.delivered, documentError: delivery.documentError,
    source, telegramPhoto: photo, telegramPhotoSizes: delivery.photoSizes,
    telegramDocument: document, verdict };
}

const argv = process.argv.slice(2);
const command = argv[0];
const defaultOut = '/opt/buena-multilogin/private/checkpoint-fidelity';
try {
  if (command === 'capture') {
    console.log(JSON.stringify(await capture({ directory: resolve(flag(argv, 'out', defaultOut)),
      label: flag(argv, 'label', 'checkpoint_human_verification_required') }), null, 2));
  } else if (command === 'send') {
    const png = flag(argv, 'png');
    if (!png) throw new Error('png_required');
    console.log(JSON.stringify(await send({ png: resolve(png),
      jobId: flag(argv, 'job-id', 'checkpoint-fidelity-synthetic') }), null, 2));
  } else if (command === 'all') {
    const captured = await capture({ directory: resolve(flag(argv, 'out', defaultOut)) });
    console.log(JSON.stringify(captured, null, 2));
    console.log(JSON.stringify(await send({ png: captured.path,
      jobId: flag(argv, 'job-id', 'checkpoint-fidelity-synthetic') }), null, 2));
  } else {
    throw new Error('unknown_command');
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error), detail: error.message }));
  process.exitCode = 1;
}

