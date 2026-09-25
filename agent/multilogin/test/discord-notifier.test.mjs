import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscordNotifier, buildCheckpointMessage, maskWebhook,
  discordWebhookPattern } from '../src/discord-notifier.mjs';
import { announceCheckpoint } from '../src/human-checkpoint.mjs';
import { PNG_SIGNATURE } from './fixtures/checkpoint-page.mjs';

// Discord is the operator alert channel. The tests cover the multipart shape,
// the required content, redaction, bounded retry behaviour and the rule that a
// notification failure never touches the checkpoint record.
const webhookUrl = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz1234567890';
const checkpoint = { id: '0d4f3feb-1f3a-4578-8964-e0a91f8497c1', jobId: 'youtube-live-04',
  accountRef: 'yt-live-04', profileRef: 'yt-live-profile-04', reason: 'human_verification_required',
  createdAt: '2026-09-25T10:00:00.000Z', expiresAt: '2026-09-25T10:30:00.000Z' };

function webhookFetch({ statuses = [204], bodies = [] } = {}) {
  const calls = [];
  let index = 0;
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const status = statuses[Math.min(index, statuses.length - 1)];
    const body = bodies[Math.min(index, bodies.length - 1)] ?? null;
    index++;
    return { status, ok: status >= 200 && status < 300,
      json: async () => body ?? {} };
  };
  return { calls, fetchImpl };
}

async function screenshot(t, name, bytes = 4096) {
  const directory = await mkdtemp(join(tmpdir(), 'discord-shot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, name);
  await writeFile(path, Buffer.concat([PNG_SIGNATURE, Buffer.alloc(bytes, 3)]));
  return path;
}

test('the notifier sends both files and the required checkpoint content', async t => {
  const canonical = await screenshot(t, '04-checkpoint_human_verification_required.png');
  const region = await screenshot(t, '04-checkpoint_human_verification_required-region.png', 1024);
  const canonicalBytes = await readFile(canonical);
  const session = webhookFetch();
  const notifier = createDiscordNotifier({ webhookUrl, fetchImpl: session.fetchImpl });
  const delivery = await notifier.notify({ checkpoint, screenshotPath: canonical, regionPath: region,
    label: 'YT-04 | HUMAN | security verification', url: 'https://accounts.google.com/signin/v2/challenge',
    visibleText: 'Verify you are human step 1', recovery: { steps: 3, budget: 8 },
    resumeCommand: 'npm run browser:job -- jobs/youtube-live-04.json --remote' });
  assert.equal(delivery.delivered, 'files');
  assert.equal(delivery.attachments, 2);
  assert.equal(session.calls.length, 1);
  assert.match(session.calls[0].url, /\?wait=true$/);
  const form = session.calls[0].options.body;
  const payload = JSON.parse(form.get('payload_json'));
  assert.equal(payload.allowed_mentions.parse.length, 0);
  const content = payload.content;
  assert.equal(content.includes('youtube-live-04'), true);
  assert.equal(content.includes('YT-04 | HUMAN | security verification'), true);
  assert.equal(content.includes('WAITING_FOR_HUMAN'), true);
  assert.equal(content.includes('human_verification_required'), true);
  assert.equal(content.includes('https://accounts.google.com/signin/v2/challenge'), true);
  assert.equal(content.includes('recovery: 3/8 steps used'), true);
  assert.equal(content.includes('npm run browser:job -- jobs/youtube-live-04.json --remote'), true);
  assert.equal(content.includes('same profile preserved: yes'), true);
  assert.deepEqual(Buffer.from(await form.get('files[0]').arrayBuffer()), canonicalBytes,
    'the canonical PNG bytes are sent unchanged');
  assert.equal(form.get('files[1]').name, '04-checkpoint_human_verification_required-region.png');
  // No credential-shaped material anywhere in the payload.
  const raw = JSON.stringify(payload) + form.get('files[0]').name;
  for (const secret of ['token', 'cookie', 'password', 'authorization']) {
    assert.equal(new RegExp(secret, 'i').test(raw), false, `payload must not mention ${secret}`);
  }
});

test('a missing region or screenshot degrades to text, never to a failure', async t => {
  const canonical = await screenshot(t, 'canonical.png');
  const session = webhookFetch();
  const notifier = createDiscordNotifier({ webhookUrl, fetchImpl: session.fetchImpl });
  const single = await notifier.notify({ checkpoint, screenshotPath: canonical });
  assert.equal(single.delivered, 'files');
  assert.equal(single.attachments, 1);
  const textSession = webhookFetch();
  const textNotifier = createDiscordNotifier({ webhookUrl, fetchImpl: textSession.fetchImpl });
  const text = await textNotifier.notify({ checkpoint });
  assert.equal(text.delivered, 'text');
  const payload = JSON.parse(textSession.calls[0].options.body);
  assert.equal(payload.content.includes('youtube-live-04'), true);
  assert.equal(textSession.calls[0].options.body instanceof FormData, false);
});

test('a 429 is retried with the Discord retry_after, a 5xx with bounded backoff', async () => {
  const sleeps = [];
  const session = webhookFetch({ statuses: [429, 204], bodies: [{ retry_after: 0.25 }, null] });
  const notifier = createDiscordNotifier({ webhookUrl, fetchImpl: session.fetchImpl,
    sleep: async ms => sleeps.push(ms) });
  const result = await notifier.notify({ checkpoint });
  assert.equal(result.ok, true);
  assert.equal(session.calls.length, 2);
  assert.equal(sleeps[0], 250);
  assert.equal(notifier.diagnostics.retries, 1);

  const failing = webhookFetch({ statuses: [500, 500, 500] });
  const failingNotifier = createDiscordNotifier({ webhookUrl, fetchImpl: failing.fetchImpl,
    sleep: async () => {} });
  await assert.rejects(failingNotifier.notify({ checkpoint }), /discord_webhook_rejected:http_500/);
  assert.equal(failing.calls.length, 3, 'two bounded retries after the first failure');
  assert.equal(failingNotifier.diagnostics.failures, 1);

  const rejected = webhookFetch({ statuses: [401] });
  const rejectedNotifier = createDiscordNotifier({ webhookUrl, fetchImpl: rejected.fetchImpl,
    sleep: async () => {} });
  await assert.rejects(rejectedNotifier.notify({ checkpoint }), /discord_webhook_rejected:http_401/);
  assert.equal(rejected.calls.length, 1, 'a rejected webhook is not retried');
});

test('the webhook credential resolves from the environment or a private file, never prints', async () => {
  const notifier = createDiscordNotifier({ environment: { DISCORD_WEBHOOK_URL: webhookUrl },
    fetchImpl: async () => ({ status: 204, json: async () => ({}) }) });
  const status = await notifier.status();
  assert.equal(status.state, 'available');
  assert.equal(status.webhook, 'webhook:…5678');
  assert.equal(JSON.stringify(status).includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(maskWebhook(webhookUrl), 'webhook:…5678');
  assert.equal(discordWebhookPattern.test(webhookUrl), true);
  assert.equal(discordWebhookPattern.test('https://evil.example/webhooks/1/x'), false);
  const missing = createDiscordNotifier({ environment: {},
    secretLoader: async () => ({ ok: false, code: 'enoent' }) });
  assert.equal(await missing.available(), false);
  assert.equal((await missing.status()).code, 'webhook_enoent');
});

test('notification failure still persists the checkpoint record', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'discord-announce-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'job.json'), JSON.stringify({ jobId: 'youtube-live-04',
    accountRef: 'yt-live-04', profileRef: 'yt-live-profile-04', state: 'waiting_for_human',
    stateTransitions: [{ state: 'waiting_for_human', reason: 'human_verification_required' }] }));
  const failingNotifier = { name: 'discord', async notify() { throw new Error('discord_webhook_rejected:http_401'); } };
  await assert.rejects(announceCheckpoint({ directory, notifier: failingNotifier }),
    /discord_webhook_rejected/);
  const stored = JSON.parse(await readFile(join(directory, 'human-checkpoint.json'), 'utf8'));
  assert.equal(stored.state, 'waiting');
  assert.equal(stored.reason, 'human_verification_required');
});

test('the checkpoint message builder includes only the documented fields', () => {
  const message = buildCheckpointMessage({ checkpoint, label: 'YT-04 | HUMAN | security verification',
    url: 'https://accounts.google.com/', recovery: { steps: 1, budget: 8 },
    visibleText: 'Verify you are human', resumeCommand: 'npm run browser:job -- jobs/youtube-live-04.json' });
  assert.match(message, /HUMAN VERIFICATION REQUIRED/);
  assert.equal(message.length <= 1900, true);
  assert.equal(/cookie|token|password/i.test(message), false);
});
