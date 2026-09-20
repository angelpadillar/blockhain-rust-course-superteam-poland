import { createInterface } from 'node:readline';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parseAccounts, requireThat, errorCode, PilotError } from '../src/core.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { createGuide } from '../src/jev.mjs';
import { runConcurrentBatch } from '../src/batch.mjs';
import { LoginBrowser, navigate, verifyIdentity, runLogin } from '../src/login.mjs';
import { completePhoneCheckpoint } from './phone-checkpoint.mjs';

const input = createInterface({ input: process.stdin, terminal: false });
const lines = input[Symbol.asyncIterator]();
let mediaMode = 'visual';
let checkpointPhone;
let checkpointPreviousPhone;
let replacePhone = false;
async function readCommand(timeoutMs) {
  let timer;
  try { return await Promise.race([lines.next().then(({ value, done }) => {
    requireThat(!done, 'vision_input_closed'); return JSON.parse(value);
  }), new Promise((_, reject) => { timer = setTimeout(() => reject(new PilotError('vision_input_timeout')), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

async function inspect({ page, account, choose, onStep, verifyOnly }) {
  if (verifyOnly) return runLogin({ page, account, choose, onStep, verifyOnly: true });
  const adapter = new LoginBrowser(page, account);
  if (checkpointPhone) { adapter.redact.add(checkpointPhone); adapter.redact.add(checkpointPhone.slice(3)); }
  if (checkpointPreviousPhone) { adapter.redact.add(checkpointPreviousPhone); adapter.redact.add(checkpointPreviousPhone.slice(3)); }
  await navigate(page, 'https://www.instagram.com/');
  await page.waitForTimeout(3000);
  let snapshot = await adapter.observe();
  if (verifyIdentity(account, snapshot)) return { verified: true, steps: 0 };
  console.log(JSON.stringify({ event: 'checkpoint_opened', page: adapter.publicPage(snapshot) }));
  requireThat(new URL(snapshot.url).pathname === '/accounts/suspended/', 'checkpoint_destination_changed');
  if (mediaMode === 'phone') {
    try { return await completePhoneCheckpoint({ page, account, adapter, phone: checkpointPhone, replacePhone, readCommand, onStep }); }
    catch (error) {
      const diagnostic = { phase: 'phone_checkpoint_diagnostic', errorType: error.name,
        message: adapter.redact(error.message).slice(0, 2500),
        page: adapter.publicPage(await adapter.observe()) };
      await onStep(diagnostic); console.log(JSON.stringify(diagnostic));
      throw error;
    }
  }
  if (/confirm you.re human to use your account/i.test(snapshot.text)) {
    const controls = snapshot.controls.filter(control => control.enabled && control.label.trim() === 'Continue');
    requireThat(controls.length === 1, 'checkpoint_continue_not_unique');
    await adapter.execute({ kind: 'submit_login', control: controls[0] }, snapshot);
    await page.waitForTimeout(3000); snapshot = await adapter.observe();
  }
  requireThat(/confirm you.re human/i.test(snapshot.text) && /hear this code|get a new code/i.test(snapshot.text), 'visual_code_screen_missing');
  await onStep({ phase: 'checkpoint_media_before', page: adapter.publicPage(snapshot) });
  let audioPath = null;
  if (mediaMode === 'audio') {
    try {
    const audioResponse = page.waitForResponse(response => /^audio\//i.test(response.headers()['content-type'] || ''), { timeout: 12000 }).catch(() => null);
    const link = page.getByText('Hear this code', { exact: true });
    requireThat(await link.count() === 1, 'audio_alternative_not_unique');
    await link.click({ noWaitAfter: true, timeout: 5000 });
    const response = await audioResponse;
    if (response) {
      const data = await response.body(); requireThat(data.length <= 2_000_000, 'challenge_audio_too_large');
      audioPath = '/data/account-pilot/checkpoint-audio';
      await writeFile(audioPath, data, { mode: 0o600 });
      console.log(JSON.stringify({ event: 'challenge_audio_captured', audioPath, mimeType: response.headers()['content-type'], bytes: data.length }));
    }
    } catch (error) {
      await onStep({ phase: 'audio_alternative_failed', errorType: error.name === 'TimeoutError' ? 'timeout' : 'media_unavailable' });
    }
    snapshot = await adapter.observe();
  }
  const fields = await page.locator('input,textarea,[contenteditable="true"],[role="textbox"]').evaluateAll(elements => elements.map(element => ({
    tag: element.tagName.toLowerCase(), type: element.getAttribute('type'), name: element.getAttribute('name'),
    role: element.getAttribute('role'), label: element.getAttribute('aria-label') || element.getAttribute('placeholder'),
    visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length),
  })));
  const imagePath = '/data/account-pilot/checkpoint-current.png';
  await page.screenshot({ path: imagePath, fullPage: false }); await chmod(imagePath, 0o600);
  let detailPath = null;
  const box = await page.locator('textarea:visible').boundingBox({ timeout: 1500 }).catch(() => null);
  const heading = await page.getByText("Confirm you're human", { exact: true }).first().boundingBox({ timeout: 1500 }).catch(() => null);
  if (box && heading && box.y > heading.y + heading.height) {
    const cdp = await page.context().newCDPSession(page);
    const captured = await cdp.send('Page.captureScreenshot', { format: 'png', clip: {
      x: Math.max(0, box.x - 10), y: heading.y + heading.height, width: box.width + 20,
      height: box.y - heading.y - heading.height, scale: 3 } });
    await cdp.detach(); detailPath = '/data/account-pilot/checkpoint-detail.png';
    await writeFile(detailPath, Buffer.from(captured.data, 'base64'), { mode: 0o600 });
  }
  await onStep({ phase: 'visual_checkpoint_ready', page: adapter.publicPage(snapshot), fields });
  console.log(JSON.stringify({ event: 'visual_checkpoint_ready', imagePath, detailPath, audioPath, fields, page: adapter.publicPage(snapshot) }));
  const command = await readCommand(600000);
  if (command.action === 'stop') throw new PilotError('visual_checkpoint_unresolved');
  requireThat(command.action === 'answer' && /^[A-Za-z0-9]{4,12}$/.test(command.answer), 'invalid_visual_answer');
  snapshot = await adapter.observe();
  requireThat(new URL(snapshot.url).pathname === '/accounts/suspended/' && /confirm you.re human/i.test(snapshot.text), 'visual_checkpoint_stale');
  const field = page.locator('input[type="text"]:visible,textarea:visible,[contenteditable="true"]:visible,[role="textbox"]:visible');
  requireThat(await field.count() === 1, 'visual_answer_field_not_unique');
  adapter.redact.add(command.answer);
  await field.fill(command.answer);
  snapshot = await adapter.observe();
  const buttons = snapshot.controls.filter(control => control.enabled && control.label.trim() === 'Next');
  requireThat(buttons.length === 1, 'visual_submit_not_unique');
  await onStep({ phase: 'visual_code_submitted', method: command.source === 'user' ? 'user-supplied-code' : 'vision-fallback', state: 'before' });
  await adapter.execute({ kind: 'submit_login', control: buttons[0] }, snapshot);
  const transitionDeadline = Date.now() + 35000;
  do {
    await page.waitForTimeout(1000); snapshot = await adapter.observe();
    if (verifyIdentity(account, snapshot) || /security check failed/i.test(snapshot.text)
      || !/confirm you.re human/i.test(snapshot.text)) break;
  } while (Date.now() < transitionDeadline);
  await onStep({ phase: 'visual_checkpoint_after', page: adapter.publicPage(snapshot) });
  console.log(JSON.stringify({ event: 'visual_checkpoint_after', page: adapter.publicPage(snapshot) }));
  if (verifyIdentity(account, snapshot)) return { verified: true, steps: 1 };
  throw new PilotError(/security check failed/i.test(snapshot.text) ? 'visual_code_rejected' : 'visual_checkpoint_next_stage');
}

try {
  const secrets = await readCommand(60000);
  mediaMode = secrets.checkpointMode || 'visual';
  checkpointPhone = secrets.checkpointPhone;
  checkpointPreviousPhone = secrets.checkpointPreviousPhone;
  replacePhone = secrets.replacePhone === true;
  const accounts = parseAccounts(JSON.stringify(secrets.accounts));
  requireThat(accounts.length === 1 && accounts[0].id === 'd30eedb5cc49c4e2b514', 'checkpoint_account_not_authorized');
  const config = JSON.parse(await readFile('config.vps.json', 'utf8')); config.seedSites = [];
  const api = new Multilogin({ token: secrets.multiloginToken, launcherUrl: config.launcherUrl });
  const result = await runConcurrentBatch({ accounts, config, api, concurrency: 1, directory: '/data/account-pilot',
    loginImpl: inspect, guideFactory: () => createGuide({ apiKey: secrets.typesafeKey }) });
  console.log(JSON.stringify(result.report, null, 2));
} catch (error) { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; }
finally { input.close(); }
