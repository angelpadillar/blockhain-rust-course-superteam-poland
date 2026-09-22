import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint, createCheckpointStore, createTelegramNotifier, parseCommand,
  verifyChallengeCleared, handleCommand, countActiveCheckpoints, healthReply,
  defaultTelegramTokenPath } from '../src/human-checkpoint.mjs';
import { classifyPage } from '../src/login.mjs';

// A synthetic challenge page: the fixture "person" clears it by flipping a flag,
// so no test ever provokes a real CAPTCHA.
function fixtureChallenge() {
  const state = { cleared: false };
  const snapshot = () => state.cleared
    ? { url: 'https://accounts.google.com/signin/v2/identifier', text: 'Sign in', challengeFrame: false,
      fingerprint: 'fp-cleared', controls: [] }
    : { url: 'https://accounts.google.com/signin/v2/challenge', challengeFrame: true,
      text: 'Verify you are human. Confirm you are not a robot.', fingerprint: 'fp-challenge', controls: [] };
  return { state, snapshot };
}

async function secretFiles(t, { token = 'bot-fixture-token', chat = '4242', user = '77',
  mode = 0o600 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-secret-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const paths = { tokenPath: join(directory, 'telegram-bot-token'),
    chatIdPath: join(directory, 'telegram-allowed-chat-id'),
    userIdPath: join(directory, 'telegram-allowed-user-id') };
  await writeFile(paths.tokenPath, `${token}\n`, { mode });
  await writeFile(paths.chatIdPath, `${chat}\n`, { mode: 0o600 });
  await writeFile(paths.userIdPath, `${user}\n`, { mode: 0o600 });
  return paths;
}

function telegram({ updates = [], fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: url.split('/').pop(), options });
    if (fail) throw new Error('network_down');
    if (url.includes('/getUpdates')) return { ok: true, json: async () => ({ ok: true, result: updates }) };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 555 } }) };
  };
  return { calls, fetchImpl };
}

test('checkpoint metadata is safe, private and moves forward only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCheckpointStore({ directory });
  const checkpoint = createCheckpoint({ jobId: 'youtube-live-01', accountRef: 'yt-live-01',
    profileRef: 'yt-live-profile-01', origin: 'https://accounts.google.com',
    reason: 'human_verification_required', seconds: 600, now: 1_000_000 });
  assert.match(checkpoint.id, /^[0-9a-f-]{36}$/);
  assert.equal(checkpoint.state, 'waiting');
  assert.equal(checkpoint.sameProfilePreserved, true);
  assert.equal(checkpoint.expiresAt, new Date(1_000_000 + 600_000).toISOString());

  await store.save(checkpoint);
  assert.equal((await store.load()).id, checkpoint.id);
  const resumed = await store.transition(await store.load(), 'resumed', { by: 'operator' });
  assert.equal(resumed.state, 'resumed');
  assert.equal(resumed.history.length, 1);
  assert.equal(JSON.parse(await readFile(store.path, 'utf8')).state, 'resumed');
  await assert.rejects(store.transition(resumed, 'waiting'), /illegal_checkpoint_transition/);
  await assert.rejects(store.transition({ ...checkpoint, state: 'nonsense' }, 'resumed'),
    /invalid_checkpoint/);
  await assert.rejects(store.transition(checkpoint, 'nonsense'), /unknown_checkpoint_state/);

  // No credential ever reaches checkpoint metadata.
  const serialized = JSON.stringify(checkpoint);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('totp'), false);
});

test('only the configured chat AND user may command a checkpoint', async t => {
  const paths = await secretFiles(t);
  const updates = [
    { update_id: 1, message: { chat: { id: 4242 }, from: { id: 77 }, text: '/status abc' } },
    { update_id: 2, message: { chat: { id: 4242 }, from: { id: 999 }, text: '/done abc' } },
    { update_id: 3, message: { chat: { id: 1234 }, from: { id: 77 }, text: '/done abc' } },
    { update_id: 4, message: { chat: { id: 4242 }, from: { id: 77 }, text: 'hello there' } },
    { update_id: 5, message: { chat: { id: 4242 }, from: { id: 77 }, text: '/done abc' } },
  ];
  const session = telegram({ updates });
  const notifier = createTelegramNotifier({ ...paths, fetchImpl: session.fetchImpl });
  assert.equal(await notifier.available(), true);
  assert.deepEqual(await notifier.status(), { notifier: 'telegram', state: 'available', chat: '4242',
    user: '77' });

  const accepted = await notifier.poll();
  assert.deepEqual(accepted.map(entry => entry.command), ['/status', '/done']);
  assert.equal(accepted[0].checkpointId, 'abc');
  assert.equal(notifier.diagnostics.unauthorizedSender, 2,
    'both the wrong chat and the wrong user are refused');
  assert.equal(notifier.diagnostics.commands, 2);
  assert.equal(session.calls[0].method, 'getUpdates', 'long polling, not a webhook');
  assert.equal(session.calls[0].url.startsWith('https://api.telegram.org/bot'), true);
  // The next poll asks only for updates it has not seen.
  await notifier.poll();
  assert.equal(JSON.parse(session.calls[1].options.body).offset, 6);
  assert.deepEqual(parseCommand({ text: 'nonsense' }), { recognized: false });
});

test('a missing secret disables the notifier without breaking the runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notifier = createTelegramNotifier({ tokenPath: join(directory, 'absent-token'),
    chatIdPath: join(directory, 'absent-chat'), userIdPath: join(directory, 'absent-user'),
    fetchImpl: async () => { throw new Error('must not be called'); } });

  assert.equal(await notifier.available(), false);
  assert.deepEqual(await notifier.status(), { notifier: 'telegram', state: 'unavailable',
    code: 'token_secret_missing' });
  await assert.rejects(notifier.notify({ checkpoint: { id: 'x', jobId: 'j' } }),
    /telegram_unavailable:token_secret_missing/);
  await assert.rejects(notifier.poll(), /telegram_unavailable:token_secret_missing/);

  const loose = await secretFiles(t, { mode: 0o644 });
  const looseNotifier = createTelegramNotifier({ ...loose, fetchImpl: telegram().fetchImpl });
  assert.equal((await looseNotifier.status()).code, 'token_secret_not_private');
  const offline = await secretFiles(t);
  const offlineNotifier = createTelegramNotifier({ ...offline, fetchImpl: telegram({ fail: true }).fetchImpl });
  await assert.rejects(offlineNotifier.poll(), /telegram_unreachable/);
  assert.equal(offlineNotifier.diagnostics.pollFailures, 1);
  assert.equal(defaultTelegramTokenPath, '/opt/buena-multilogin/private/telegram-bot-token');
});

test('the synthetic checkpoint fixture: notify, wait, /done, re-observe, resume', async t => {
  const paths = await secretFiles(t);
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCheckpointStore({ directory });
  const challenge = fixtureChallenge();
  assert.equal(classifyPage(challenge.snapshot()), 'human_verification_required');

  // A synthetic PNG stands in for the safe capture the runtime takes.
  const screenshotPath = join(directory, 'checkpoint.png');
  await writeFile(screenshotPath, Buffer.from('89504e470d0a1a0a', 'hex'), { mode: 0o600 });

  const checkpoint = createCheckpoint({ jobId: 'youtube-live-fixture', accountRef: 'yt-live-01',
    origin: 'https://accounts.google.com', reason: 'human_verification_required', seconds: 600,
    screenshotPath });
  await store.save(checkpoint);

  // 1. One photo plus safe metadata is delivered.
  const send = telegram();
  const notifier = createTelegramNotifier({ ...paths, fetchImpl: send.fetchImpl });
  const delivery = await notifier.notify({ checkpoint });
  assert.equal(delivery.delivered, 'photo');
  assert.equal(send.calls[0].method, 'sendPhoto');
  const form = send.calls[0].options.body;
  assert.equal(form.get('chat_id'), '4242');
  const caption = form.get('caption');
  assert.equal(caption.includes(checkpoint.id), true);
  assert.equal(caption.includes('same profile preserved: yes'), true);
  assert.equal(caption.includes('youtube-live-fixture'), true);
  assert.equal(caption.includes('bot-fixture-token'), false, 'never the token');

  // 2. The job waits; /status from the allowlisted account reports the checkpoint.
  assert.equal((await store.load()).state, 'waiting');
  const statusNotifier = createTelegramNotifier({ ...paths, fetchImpl: telegram({ updates: [
    { update_id: 10, message: { chat: { id: 4242 }, from: { id: 77 },
      text: `/status ${checkpoint.id}` } }] }).fetchImpl });
  assert.deepEqual((await statusNotifier.poll()).map(entry => entry.command), ['/status']);

  // 3. /done arrives BEFORE the person cleared it: /done is not proof on its own.
  const premature = await verifyChallengeCleared({ checkpoint, observe: async () => challenge.snapshot(),
    classify: classifyPage });
  assert.equal(premature.cleared, false);
  assert.equal(premature.reason, 'challenge_frame_present');
  assert.equal((await store.load()).state, 'waiting');

  // 4. The fixture "person" clears it; /done verifies and only then resumes.
  challenge.state.cleared = true;
  const cleared = await verifyChallengeCleared({ checkpoint, observe: async () => challenge.snapshot(),
    classify: classifyPage });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.reason, 'challenge_absent');
  const resumed = await store.transition(await store.load(), 'resumed',
    { by: 'operator', reason: cleared.reason });
  assert.equal(resumed.state, 'resumed');
  assert.equal(resumed.history.length, 1);

  // 5. /cancel ends the wait without touching the challenge.
  const cancelled = await store.transition(createCheckpoint({ jobId: 'j2',
    reason: 'human_verification_required' }), 'cancelled', { by: 'operator' });
  assert.equal(cancelled.state, 'cancelled');
});

test('/start and a bare /status answer with health and the waiting checkpoint count', async t => {
  const paths = await secretFiles(t);
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-health-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Two waiting checkpoints and one already resumed: only the waiting ones count.
  for (const [jobId, state] of [['j1', 'waiting'], ['j2', 'waiting'], ['j3', 'resumed']]) {
    const store = createCheckpointStore({ directory: join(directory, 'jobs', jobId) });
    await store.save({ ...createCheckpoint({ jobId, reason: 'human_verification_required' }), state });
  }
  const active = await countActiveCheckpoints({ directory });
  assert.equal(active.active, 2);
  assert.equal(active.checkpointIds.length, 2);

  const session = telegram();
  const notifier = createTelegramNotifier({ ...paths, fetchImpl: session.fetchImpl });
  const store = createCheckpointStore({ directory });
  const send = async args => {
    const parsed = parseCommand({ text: args, chatId: '4242', userId: '77' });
    return handleCommand({ parsed, notifier, store,
      loadCheckpoint: async () => null, loadActive: async () => active });
  };

  const started = await send('/start');
  assert.equal(started.action, 'replied');
  assert.equal(started.reply.includes('browser runtime online'), true);
  assert.equal(started.reply.includes('waiting checkpoints: 2'), true);
  assert.equal(started.reply.includes('/done'), true);

  const status = await send('/status');
  assert.equal(status.action, 'replied');
  assert.equal(status.reply.includes('waiting checkpoints: 2'), true);

  // Both replies went out to the configured chat as real Telegram messages.
  const sends = session.calls.filter(call => call.method === 'sendMessage');
  assert.equal(sends.length, 2);
  assert.equal(sends.every(call => JSON.parse(call.options.body).chat_id === '4242'), true);
  assert.deepEqual(parseCommand({ text: '/start' }).command, '/start');
});

test('/status, /done and /cancel with a checkpoint act on the checkpoint only', async () => {
  const sent = [];
  const notifier = { name: 'telegram', send: async ({ text }) => { sent.push(text); return { ok: true }; } };
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-commands-'));
  const store = createCheckpointStore({ directory });
  const checkpoint = createCheckpoint({ jobId: 'j1', reason: 'human_verification_required' });
  await store.save(checkpoint);
  const load = async id => (id === checkpoint.id ? await store.load() : null);

  const status = await handleCommand({ parsed: { recognized: true, command: '/status',
    checkpointId: checkpoint.id }, notifier, store, loadCheckpoint: load });
  assert.equal(status.action, 'replied');
  assert.equal(status.reply.includes(`checkpoint: ${checkpoint.id}`), true);

  // /done while the challenge is still there: no resume, explicit reason.
  const stillThere = await handleCommand({ parsed: { recognized: true, command: '/done',
    checkpointId: checkpoint.id }, notifier, store, loadCheckpoint: load,
  verify: async () => ({ cleared: false, reason: 'challenge_frame_present' }) });
  assert.equal(stillThere.action, 'waiting');
  assert.equal((await store.load()).state, 'waiting');
  assert.equal(sent.at(-1).includes('challenge still present'), true);

  // /done after the person cleared it: resume is allowed.
  const cleared = await handleCommand({ parsed: { recognized: true, command: '/done',
    checkpointId: checkpoint.id }, notifier, store, loadCheckpoint: load,
  verify: async () => ({ cleared: true, reason: 'challenge_absent' }) });
  assert.equal(cleared.action, 'resumed');
  assert.equal((await store.load()).state, 'resumed');

  const unknown = await handleCommand({ parsed: { recognized: true, command: '/status',
    checkpointId: 'nope' }, notifier, store, loadCheckpoint: load });
  assert.equal(unknown.reply.includes('unknown checkpoint'), true);

  const cancelled = await handleCommand({ parsed: { recognized: true, command: '/cancel',
    checkpointId: checkpoint.id }, notifier, store,
  loadCheckpoint: async () => ({ ...checkpoint, state: 'waiting' }) });
  assert.equal(cancelled.action, 'cancelled');
});

test('the poll offset survives a restart and a replayed update is never handled twice', async t => {
  const paths = await secretFiles(t);
  const directory = await mkdtemp(join(tmpdir(), 'telegram-offset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const offsetPath = join(directory, 'telegram-offset.json');
  const updates = [{ update_id: 500, message: { chat: { id: 4242 }, from: { id: 77 }, text: '/status' } }];

  const first = createTelegramNotifier({ ...paths, offsetPath,
    fetchImpl: telegram({ updates }).fetchImpl });
  assert.deepEqual((await first.poll()).map(entry => entry.command), ['/status']);
  const state = JSON.parse(await readFile(offsetPath, 'utf8'));
  assert.equal(state.offset, 501, 'the offset is persisted');
  assert.deepEqual(state.processed, [500], 'handled update ids are remembered');
  assert.equal(((await stat(offsetPath)).mode & 0o077) === 0, true, 'the state file is private');

  // A fresh notifier (restart) picks up the stored offset and asks from there.
  const session = telegram({ updates });
  const restarted = createTelegramNotifier({ ...paths, offsetPath, fetchImpl: session.fetchImpl });
  await restarted.poll();
  assert.equal(JSON.parse(session.calls[0].options.body).offset, 501, 'resumes, it does not replay');

  // Even with an offset that rolled back, a replayed update is deduped.
  await writeFile(offsetPath, JSON.stringify({ offset: 0, processed: [500] }), { mode: 0o600 });
  const replay = createTelegramNotifier({ ...paths, offsetPath,
    fetchImpl: telegram({ updates }).fetchImpl });
  assert.deepEqual(await replay.poll(), []);
  assert.equal(replay.diagnostics.duplicates, 1);
  assert.equal(replay.diagnostics.commands, 0);
});

test('polling backs off after a Telegram outage instead of retrying hard', async t => {
  const paths = await secretFiles(t);
  const clock = { value: 1_000_000 };
  const failing = createTelegramNotifier({ ...paths, now: () => clock.value,
    fetchImpl: telegram({ fail: true }).fetchImpl });
  await assert.rejects(failing.poll(), /telegram_unreachable/);
  assert.equal(failing.backoffMs(), 4000, 'the first failure doubles the base backoff');
  assert.deepEqual(await failing.poll(), [], 'the API is not called inside the window');
  clock.value += failing.backoffMs() + 1;
  await assert.rejects(failing.poll(), /telegram_unreachable/, 'the retry happens after the window');
  assert.equal(failing.backoffMs(), 8000, 'a second failure doubles again');
  assert.equal(failing.diagnostics.pollFailures >= 2, true);

  // One failing attempt, then a skip: inside the window the API is not called.
  const calls = [];
  let attempt = 0;
  const flaky = createTelegramNotifier({ ...paths, now: () => clock.value,
    fetchImpl: async url => { calls.push(url); attempt++;
      if (attempt === 1) throw new Error('offline');
      return { ok: true, json: async () => ({ ok: true, result: [] }) }; } });
  await assert.rejects(flaky.poll(), /telegram_unreachable/);
  assert.deepEqual(await flaky.poll(), [], 'a call inside the backoff window is skipped');
  assert.equal(flaky.diagnostics.backoffSkips, 1);
  assert.equal(calls.length, 1, 'no second network call while backing off');
  // Once the window passes, polling resumes normally.
  clock.value += flaky.backoffMs() + 1;
  assert.deepEqual(await flaky.poll(), []);
  assert.equal(calls.length, 2);
});

test('terminal and expired checkpoints answer idempotently and never resume', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCheckpointStore({ directory });
  const sent = [];
  const notifier = { name: 'telegram', send: async ({ text }) => { sent.push(text); return { ok: true }; } };

  // An already cancelled checkpoint: the same answer, no exception.
  const cancelled = { ...createCheckpoint({ jobId: 'j1', reason: 'human_verification_required' }),
    state: 'cancelled' };
  const again = await handleCommand({ parsed: { recognized: true, command: '/cancel',
    checkpointId: cancelled.id }, notifier, store, loadCheckpoint: async () => cancelled });
  assert.equal(again.action, 'noop');
  assert.equal(again.reply.includes('already cancelled'), true);
  assert.equal((await store.load()), null, 'a terminal checkpoint is not rewritten');

  // A /done on a resumed checkpoint is not a second resume either.
  const resumed = { ...createCheckpoint({ jobId: 'j2', reason: 'human_verification_required' }),
    state: 'resumed' };
  const secondDone = await handleCommand({ parsed: { recognized: true, command: '/done',
    checkpointId: resumed.id }, notifier, store, loadCheckpoint: async () => resumed,
  verify: async () => ({ cleared: true, reason: 'challenge_absent' }) });
  assert.equal(secondDone.action, 'noop');
  assert.equal(secondDone.reply.includes('already resumed'), true);

  // An expired checkpoint is moved to expired and refuses to resume even if the
  // page would pass verification.
  const expired = createCheckpoint({ jobId: 'j3', reason: 'human_verification_required', seconds: 600,
    now: 1_000_000 });
  const jobStore = createCheckpointStore({ directory: join(directory, 'jobs', 'j3') });
  await jobStore.save(expired);
  let verified = 0;
  // The store that owns the checkpoint is the one the handler must write through,
  // exactly as the CLI passes it per job directory.
  const late = await handleCommand({ parsed: { recognized: true, command: '/done',
    checkpointId: expired.id }, notifier, store: jobStore, now: () => 1_000_000 + 600_001,
  loadCheckpoint: async () => jobStore.load(),
  verify: async () => { verified++; return { cleared: true, reason: 'challenge_absent' }; } });
  assert.equal(late.action, 'expired');
  assert.equal(verified, 0, 'an expired checkpoint is not re-observed for resume');
  assert.equal((await jobStore.load()).state, 'expired');
  assert.equal(late.reply.includes('expired'), true);

  // An expired checkpoint is no longer counted as waiting.
  // The same directory still counts a live checkpoint, so the exclusion is real.
  const live = createCheckpoint({ jobId: 'j4', reason: 'human_verification_required', seconds: 600,
    now: 1_000_000 });
  await createCheckpointStore({ directory: join(directory, 'jobs', 'j4') }).save(live);
  assert.equal((await countActiveCheckpoints({ directory,
    now: () => 1_000_000 + 600_001 })).active, 0, 'the expired one is not waiting');
  assert.equal((await countActiveCheckpoints({ directory,
    now: () => 1_000_000 + 1 })).active, 1, 'a live checkpoint still counts');
});

test('a challenge that is still present after /done never resumes', async () => {
  const snapshot = { url: 'https://accounts.google.com/signin/v2/challenge', challengeFrame: false,
    text: 'Verify you are human', fingerprint: 'fp', controls: [] };
  const checkpoint = createCheckpoint({ jobId: 'j1', reason: 'human_verification_required' });
  const still = await verifyChallengeCleared({ checkpoint, observe: async () => snapshot,
    classify: classifyPage });
  assert.equal(still.cleared, false);
  assert.equal(still.reason, 'challenge_still_present');

  const unavailable = await verifyChallengeCleared({ checkpoint,
    observe: async () => { throw new Error('page gone'); }, classify: classifyPage });
  assert.deepEqual(unavailable, { cleared: false, reason: 'observation_unavailable' });
});
