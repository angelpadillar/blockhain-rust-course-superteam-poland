import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { PilotError, requireThat } from './core.mjs';
import { readJson, writeJson } from './storage.mjs';
import { loadSecret } from './frontier.mjs';

// G3: a generic human-checkpoint notifier, with Telegram as its first adapter.
// It coordinates a genuine external verification: it never answers, clicks or
// solves a challenge. L1/L2 keep working when this integration is unavailable.
export const defaultTelegramTokenPath = '/opt/buena-multilogin/private/telegram-bot-token';
export const defaultTelegramChatIdPath = '/opt/buena-multilogin/private/telegram-allowed-chat-id';
export const defaultTelegramUserIdPath = '/opt/buena-multilogin/private/telegram-allowed-user-id';
export const defaultTelegramApi = 'https://api.telegram.org';
export const defaultTelegramOffsetPath = '/opt/buena-multilogin/private/telegram-offset.json';
// Exponential backoff while Telegram is unreachable, capped so a long outage does
// not turn into a tight retry loop.
export const baseBackoffMs = 2000;
export const maxBackoffMs = 60000;
export const checkpointStates = ['waiting', 'resumed', 'cancelled', 'expired'];

// Checkpoint metadata is private state about a live profile, never a credential.
export function createCheckpoint({ jobId, accountRef = null, profileRef = null, origin = null,
  reason, seconds = 600, screenshotPath = null, now = Date.now } = {}) {
  requireThat(typeof jobId === 'string' && jobId.length > 0, 'checkpoint_job_required');
  requireThat(typeof reason === 'string' && reason.length > 0, 'checkpoint_reason_required');
  const id = randomUUID();
  // `now` may be a clock function or a fixed timestamp (tests use both).
  const createdAt = typeof now === 'function' ? now() : now;
  return { id, jobId, accountRef, profileRef, origin, reason,
    sameProfilePreserved: true, createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(createdAt + seconds * 1000).toISOString(),
    state: 'waiting', screenshot: screenshotPath, notifiedAt: null, messageId: null, history: [] };
}

export function createCheckpointStore({ directory }) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'checkpoint_directory_required');
  const path = resolve(directory, 'human-checkpoint.json');
  return {
    path,
    async save(checkpoint) { await writeJson(path, checkpoint); return checkpoint; },
    async load() { return readJson(path, null).catch(() => null); },
    // A checkpoint only ever moves forward: waiting -> resumed | cancelled |
    // expired, and a terminal state is final. A late or repeated command is
    // refused rather than reopening a checkpoint.
    async transition(checkpoint, state, detail = {}) {
      requireThat(checkpointStates.includes(state), 'unknown_checkpoint_state');
      const allowed = { waiting: ['resumed', 'cancelled', 'expired'],
        resumed: [], cancelled: [], expired: [] };
      requireThat(checkpoint?.state && allowed[checkpoint.state], 'invalid_checkpoint');
      requireThat(allowed[checkpoint.state].includes(state),
        `illegal_checkpoint_transition:${checkpoint.state}->${state}`);
      const at = new Date().toISOString();
      const next = { ...checkpoint, state, history: [...(checkpoint.history || []), { state, at, ...detail }] };
      return this.save(next);
    },
  };
}

export function parseCommand({ text = '', chatId = null, userId = null } = {}) {
  const match = String(text).trim().match(/^\/(start|status|done|cancel)(?:\s+(\S+))?$/i);
  if (!match) return { recognized: false };
  return { recognized: true, command: `/${match[1].toLowerCase()}`, checkpointId: match[2] || null,
    chatId, userId };
}

export const checkpointUsage = 'Commands: /status [checkpoint] | /done <checkpoint> | /cancel <checkpoint>';

// How many job checkpoints are still waiting for a person.
export async function countActiveCheckpoints({ directory, fs = null, now = Date.now } = {}) {
  const io = fs || { readdir: (await import('node:fs/promises')).readdir,
    readFile: (await import('node:fs/promises')).readFile };
  let jobIds = [];
  try { jobIds = await io.readdir(resolve(directory, 'jobs')); } catch { return { active: 0, checkpointIds: [] }; }
  const checkpointIds = [];
  for (const jobId of jobIds.sort()) {
    let checkpoint = null;
    try { checkpoint = JSON.parse(await io.readFile(resolve(directory, 'jobs', jobId, 'human-checkpoint.json'), 'utf8')); }
    catch { continue; }
    const expired = checkpoint?.expiresAt ? Date.parse(checkpoint.expiresAt) <= now() : false;
    if (checkpoint?.state === 'waiting' && !expired && checkpoint.id) checkpointIds.push(checkpoint.id);
  }
  return { active: checkpointIds.length, checkpointIds };
}

// The health reply: what the runtime is, and whether anything is waiting.
export function healthReply({ notifier = null, active = 0, note = null } = {}) {
  const lines = ['browser runtime online'];
  if (notifier) lines.push(`notifier: ${notifier.name || 'unknown'}`);
  lines.push(`waiting checkpoints: ${active}`);
  if (note) lines.push(note);
  lines.push(checkpointUsage);
  lines.push('Human verification is never solved automatically: a person resolves it in the preserved browser.');
  return lines.join('\n');
}

// Command handling. `/done` is a request, not a proof: the injected `verify`
// re-observes the SAME browser and the checkpoint only resumes when the challenge
// is genuinely gone.
export async function handleCommand({ parsed, notifier = null, store = null,
  loadCheckpoint = async () => null, loadActive = async () => 0, verify = null, now = Date.now } = {}) {
  requireThat(parsed?.recognized, 'unrecognized_command');
  const command = parsed.command;
  const checkpointId = parsed.checkpointId;

  if (command === '/start' || (command === '/status' && !checkpointId)) {
    const { active } = await loadActive().then(result => (typeof result === 'number' ? { active: result } : result));
    const reply = healthReply({ notifier, active });
    if (notifier) await notifier.send({ text: reply });
    return { action: 'replied', reply };
  }

  const checkpoint = checkpointId ? await loadCheckpoint(checkpointId) : null;
  if (!checkpoint) {
    const reply = `unknown checkpoint: ${checkpointId || '(none)'}\n${checkpointUsage}`;
    if (notifier) await notifier.send({ text: reply });
    return { action: 'replied', reply };
  }
  const expired = Date.parse(checkpoint.expiresAt) <= now();
  const summary = [`checkpoint: ${checkpoint.id}`, `job: ${checkpoint.jobId}`,
    `reason: ${checkpoint.reason}`, `state: ${checkpoint.state}`,
    `expires: ${checkpoint.expiresAt}`, `same profile preserved: yes`].join('\n');

  if (command === '/status') {
    if (notifier) await notifier.send({ text: `${summary}${expired ? '\nexpired' : ''}` });
    return { action: 'replied', reply: summary };
  }
  if (command === '/cancel') {
    // Idempotent: a checkpoint that already ended answers the same way again.
    if (checkpoint.state !== 'waiting') {
      const reply = `checkpoint already ${checkpoint.state}; nothing to do.\n${summary}`;
      if (notifier) await notifier.send({ text: reply });
      return { action: 'noop', reply, checkpoint };
    }
    const cancelled = store ? await store.transition(checkpoint, 'cancelled', { by: 'operator' }) : checkpoint;
    const reply = `checkpoint cancelled. The browser session is left as it is.\n${summary}`;
    if (notifier) await notifier.send({ text: reply });
    return { action: 'cancelled', reply, checkpoint: cancelled };
  }
  if (command === '/done') {
    if (checkpoint.state !== 'waiting') {
      const reply = `checkpoint already ${checkpoint.state}; nothing to do.\n${summary}`;
      if (notifier) await notifier.send({ text: reply });
      return { action: 'noop', reply, checkpoint };
    }
    // An expired checkpoint never resumes, whatever the operator says.
    if (expired) {
      const expiredCheckpoint = store ? await store.transition(checkpoint, 'expired',
        { by: 'expiry' }) : checkpoint;
      const reply = `checkpoint expired at ${checkpoint.expiresAt}; not resuming.\n${summary}`;
      if (notifier) await notifier.send({ text: reply });
      return { action: 'expired', reply, checkpoint: expiredCheckpoint };
    }
    // Re-observe before believing it: /done alone never resumes the flow.
    const outcome = verify ? await verify({ checkpoint }) : { cleared: false, reason: 'verification_unavailable' };
    if (!outcome.cleared) {
      const reply = `challenge still present (${outcome.reason}); staying in waiting.\n${summary}`;
      if (notifier) await notifier.send({ text: reply });
      return { action: 'waiting', reply, reason: outcome.reason };
    }
    const resumed = store ? await store.transition(checkpoint, 'resumed', { by: 'operator', reason: outcome.reason })
      : checkpoint;
    const reply = `challenge cleared (${outcome.reason}); resuming the same profile.\n${summary}`;
    if (notifier) await notifier.send({ text: reply });
    return { action: 'resumed', reply, checkpoint: resumed };
  }
  return { action: 'ignored', reply: checkpointUsage };
}

// `/done` must not blindly resume: the SAME browser is re-observed and the
// challenge has to be genuinely gone before the flow continues.
export async function verifyChallengeCleared({ checkpoint, observe, classify } = {}) {
  requireThat(typeof observe === 'function', 'checkpoint_observe_required');
  requireThat(typeof classify === 'function', 'checkpoint_classify_required');
  const snapshot = await observe().catch(() => null);
  if (!snapshot) return { cleared: false, reason: 'observation_unavailable' };
  if (snapshot.challengeFrame === true) return { cleared: false, reason: 'challenge_frame_present' };
  const classification = classify(snapshot);
  if (classification === checkpoint.reason) return { cleared: false, reason: 'challenge_still_present' };
  return { cleared: true, reason: classification ? `page_now_classified:${classification}` : 'challenge_absent' };
}

// Bind the frame the job ALREADY captured to a durable checkpoint record and
// announce it. The image is never re-captured, resized or re-encoded here: the
// job wrote it through captureSafeScreenshot at native resolution and this only
// reads the same bytes. The record carries job/profile/checkpoint identity and
// the expiry, and is reused when one is already waiting, so a repeated announce
// is idempotent instead of sending the operator a second alert.
export async function announceCheckpoint({ directory, notifier = null, seconds = 1800,
  reason = null, screenshotPath = null, now = Date.now, persist = true,
  fs = { readdir, readFile } } = {}) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'checkpoint_directory_required');
  const jobDirectory = resolve(directory);
  const job = await readJson(resolve(jobDirectory, 'job.json'), null).catch(() => null);
  const store = createCheckpointStore({ directory: jobDirectory });
  const existing = await store.load();
  // A checkpoint that already ended is never reopened or re-announced.
  if (existing && existing.state !== 'waiting') return { checkpoint: existing, delivery: null, repeated: true };
  if (existing && Date.parse(existing.expiresAt) > now()) {
    const delivery = notifier ? await notifier.notify({ checkpoint: existing, screenshotPath }) : null;
    return { checkpoint: existing, delivery, repeated: true };
  }
  const shot = screenshotPath || await newestCheckpointScreenshot({ directory: jobDirectory, fs });
  const waiting = (job?.stateTransitions || []).filter(item => item.state === 'waiting_for_human');
  const derived = reason || waiting.at(-1)?.reason
    || /^checkpoint_(.+)\.png$/.exec(shot ? basename(shot) : '')?.[1] || 'human_verification_required';
  const checkpoint = createCheckpoint({ jobId: job?.jobId || basename(jobDirectory),
    accountRef: job?.accountRef || null, profileRef: job?.profileRef || null,
    origin: job?.origin || 'https://accounts.google.com', reason: derived, seconds,
    screenshotPath: shot, now });
  if (persist) await store.save(checkpoint);
  const delivery = notifier ? await notifier.notify({ checkpoint }) : null;
  if (delivery && persist) {
    await store.save({ ...checkpoint, notifiedAt: new Date(now()).toISOString(),
      messageId: delivery.previewMessageId ?? delivery.messageId ?? null,
      documentMessageId: delivery.documentMessageId ?? null });
  }
  return { checkpoint, delivery, repeated: false };
}

// The newest checkpoint frame the job's captureSafeScreenshot wrote. The file is
// chosen by name, never re-rendered.
async function newestCheckpointScreenshot({ directory, fs }) {
  let names = [];
  try { names = await fs.readdir(resolve(directory, 'screenshots')); } catch { return null; }
  const candidates = names.filter(name => /^.*checkpoint_.*\.png$/.test(name)).sort();
  return candidates.length ? resolve(directory, 'screenshots', candidates.at(-1)) : null;
}

export function createTelegramNotifier({ tokenPath = defaultTelegramTokenPath,
  chatIdPath = defaultTelegramChatIdPath, userIdPath = defaultTelegramUserIdPath,
  apiBase = defaultTelegramApi, fetchImpl = fetch, secretLoader = loadSecret, timeoutMs = 25000,
  offsetPath = null, now = Date.now } = {}) {
  requireThat(typeof fetchImpl === 'function', 'telegram_fetch_required');
  let config = null;
  let offset = 0;
  let processed = new Set();
  let stateLoaded = false;
  let failures = 0;
  let backoffUntil = 0;
  const diagnostics = { unauthorizedSender: 0, notified: 0, commands: 0, pollFailures: 0,
    duplicates: 0, backoffSkips: 0, documentFailures: 0, lastError: null };

  // The offset and the recent update ids live in a private file, so a restart
  // neither re-reads old commands nor loses its place in the queue.
  const loadState = async () => {
    if (stateLoaded) return;
    stateLoaded = true;
    if (!offsetPath) return;
    const state = await readJson(offsetPath, null).catch(() => null);
    if (!state) return;
    if (Number.isSafeInteger(state.offset) && state.offset >= 0) offset = state.offset;
    if (Array.isArray(state.processed)) processed = new Set(state.processed.filter(Number.isSafeInteger));
  };
  const saveState = async () => {
    if (!offsetPath) return;
    await writeJson(offsetPath, { offset, processed: [...processed].slice(-200) });
  };
  const backoffMs = () => Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.min(failures, 5));

  async function resolveConfig() {
    if (config) return config;
    const [token, chatId, userId] = await Promise.all([
      secretLoader(tokenPath), secretLoader(chatIdPath), secretLoader(userIdPath)]);
    if (!token.ok || !chatId.ok || !userId.ok) {
      const code = !token.ok ? `token_${token.code}` : !chatId.ok ? `chat_${chatId.code}` : `user_${userId.code}`;
      config = { ok: false, code };
      return config;
    }
    config = { ok: true, token: token.value, chatId: chatId.value.trim(), userId: userId.value.trim() };
    return config;
  }

  const call = async (method, body, { form = null } = {}) => {
    const resolved = await resolveConfig();
    requireThat(resolved.ok, `telegram_unavailable:${resolved.code}`);
    let response;
    try {
      response = await fetchImpl(`${apiBase}/bot${resolved.token}/${method}`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        ...(form ? { body: form }
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    } catch (error) {
      diagnostics.pollFailures++; diagnostics.lastError = error?.code || error?.name || 'network';
      throw new PilotError('telegram_unreachable');
    }
    let payload;
    try { payload = await response.json(); } catch { throw new PilotError('telegram_invalid_response'); }
    if (!payload?.ok) {
      diagnostics.lastError = payload?.description || `http_${response.status}`;
      throw new PilotError('telegram_request_failed');
    }
    return payload.result;
  };

  return {
    name: 'telegram',
    diagnostics,
    async available() { return (await resolveConfig()).ok; },
    async status() {
      const resolved = await resolveConfig();
      return resolved.ok
        ? { notifier: 'telegram', state: 'available', chat: resolved.chatId, user: resolved.userId }
        : { notifier: 'telegram', state: 'unavailable', code: resolved.code };
    },
    // A checkpoint screenshot plus safe metadata. Never credentials, never page text.
    //
    // Telegram re-encodes anything sent as a photo (sendPhoto), which softens fine
    // text and detail. The operator therefore gets BOTH: a photo preview for the
    // immediate alert, and the ORIGINAL PNG as a document, sent with the same
    // bytes and the same source filename so nothing is resized or recompressed.
    // The preview is sent first so the alert is visible even if the document
    // upload is slow.
    async notify({ checkpoint, screenshotPath = null, sendOriginal = true } = {}) {
      requireThat(checkpoint?.id, 'checkpoint_required');
      const resolved = await resolveConfig();
      requireThat(resolved.ok, `telegram_unavailable:${resolved.code}`);
      const caption = ['Human verification required', `job: ${checkpoint.jobId}`,
        checkpoint.accountRef ? `account: ${checkpoint.accountRef}` : null,
        checkpoint.origin ? `site: ${checkpoint.origin}` : null,
        `checkpoint: ${checkpoint.id}`, `reason: ${checkpoint.reason}`,
        `expires: ${checkpoint.expiresAt}`, 'same profile preserved: yes',
        `reply: /done ${checkpoint.id}  |  /status ${checkpoint.id}  |  /cancel ${checkpoint.id}`,
      ].filter(Boolean).join('\n');
      const path = screenshotPath || checkpoint.screenshot;
      const bytes = path ? await readFile(path).catch(() => null) : null;
      if (bytes) {
        // 1. Photo preview: the alert itself, already captioned with the checkpoint.
        const preview = new FormData();
        preview.set('chat_id', resolved.chatId);
        preview.set('caption', caption);
        preview.set('photo', new Blob([bytes], { type: 'image/png' }), 'checkpoint.png');
        const photo = await call('sendPhoto', null, { form: preview });
        diagnostics.notified++;
        // 2. The original PNG verbatim, so the operator can read the fine detail.
        const name = basename(String(path));
        let document = null;
        let documentError = null;
        if (sendOriginal) {
          const original = new FormData();
          original.set('chat_id', resolved.chatId);
          original.set('caption', `Original screenshot, no Telegram recompression: ${checkpoint.id}`);
          original.set('document', new Blob([bytes], { type: 'image/png' }), name);
          try { document = await call('sendDocument', null, { form: original }); diagnostics.notified++; }
          catch (error) { documentError = error?.code || 'document_failed'; diagnostics.documentFailures++; }
        }
        return { ok: true,
          messageId: photo?.message_id ?? null,
          previewMessageId: photo?.message_id ?? null,
          photoFileId: photo?.photo?.at?.(-1)?.file_id ?? null,
          // Telegram's own view of the photo it decided to store, for the
          // fidelity diagnostic: it may be recompressed and/or resized.
          photoSizes: (photo?.photo ?? []).map(size => ({ width: size.width ?? null,
            height: size.height ?? null, bytes: size.file_size ?? null })),
          documentMessageId: document?.message_id ?? null,
          documentFileId: document?.document?.file_id ?? null,
          documentName: sendOriginal ? name : null,
          documentError,
          delivered: document ? 'photo+document' : 'photo' };
      }
      const result = await call('sendMessage', { chat_id: resolved.chatId, text: caption });
      diagnostics.notified++;
      return { ok: true, messageId: result?.message_id ?? null, delivered: 'text' };
    },
    // A reply always goes to the configured chat, never to whoever asked.
    async send({ text: message } = {}) {
      requireThat(typeof message === 'string' && message.length > 0, 'telegram_message_required');
      const resolved = await resolveConfig();
      requireThat(resolved.ok, `telegram_unavailable:${resolved.code}`);
      const result = await call('sendMessage', { chat_id: resolved.chatId,
        text: message.slice(0, 2000), disable_web_page_preview: true });
      return { ok: true, messageId: result?.message_id ?? null };
    },
    // Long polling: no public webhook is required. Only the configured chat AND
    // user are accepted; anything else is counted and ignored.
    backoffMs,
    async poll({ limit = 10 } = {}) {
      const resolved = await resolveConfig();
      requireThat(resolved.ok, `telegram_unavailable:${resolved.code}`);
      await loadState();
      // While backing off, a call is skipped entirely rather than retried hard.
      if (now() < backoffUntil) { diagnostics.backoffSkips++; return []; }
      let updates;
      try {
        updates = await call('getUpdates', { offset, limit, timeout: 0, allowed_updates: ['message'] });
        failures = 0;
      } catch (error) {
        failures++; backoffUntil = now() + backoffMs(); diagnostics.lastError = error.message || 'unreachable';
        await saveState().catch(() => {});
        throw error;
      }
      const accepted = [];
      for (const update of updates || []) {
        const updateId = Number.isSafeInteger(update.update_id) ? update.update_id : null;
        offset = Math.max(offset, (updateId ?? 0) + 1);
        // A replayed update (older offset after a restart) is never handled twice.
        if (updateId !== null && processed.has(updateId)) { diagnostics.duplicates++; continue; }
        if (updateId !== null) processed.add(updateId);
        const message = update.message || update.edited_message || null;
        const chatId = String(message?.chat?.id ?? '');
        const userId = String(message?.from?.id ?? '');
        const parsed = parseCommand({ text: message?.text || '', chatId, userId });
        if (!parsed.recognized) continue;
        if (chatId !== resolved.chatId || userId !== resolved.userId) {
          diagnostics.unauthorizedSender++;
          continue;
        }
        diagnostics.commands++;
        accepted.push(parsed);
      }
      await saveState();
      return accepted;
    },
  };
}
