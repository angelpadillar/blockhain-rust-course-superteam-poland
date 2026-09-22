import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  const match = String(text).trim().match(/^\/(status|done|cancel)(?:\s+(\S+))?$/i);
  if (!match) return { recognized: false };
  return { recognized: true, command: `/${match[1].toLowerCase()}`, checkpointId: match[2] || null,
    chatId, userId };
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

export function createTelegramNotifier({ tokenPath = defaultTelegramTokenPath,
  chatIdPath = defaultTelegramChatIdPath, userIdPath = defaultTelegramUserIdPath,
  apiBase = defaultTelegramApi, fetchImpl = fetch, secretLoader = loadSecret, timeoutMs = 25000 } = {}) {
  requireThat(typeof fetchImpl === 'function', 'telegram_fetch_required');
  let config = null;
  let offset = 0;
  const diagnostics = { unauthorizedSender: 0, notified: 0, commands: 0, pollFailures: 0, lastError: null };

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
    // One photo plus safe metadata. Never credentials, never page text.
    async notify({ checkpoint, screenshotPath = null } = {}) {
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
      if (path) {
        const bytes = await readFile(path).catch(() => null);
        if (bytes) {
          const form = new FormData();
          form.set('chat_id', resolved.chatId);
          form.set('caption', caption);
          form.set('photo', new Blob([bytes], { type: 'image/png' }), 'checkpoint.png');
          const result = await call('sendPhoto', null, { form });
          diagnostics.notified++;
          return { ok: true, messageId: result?.message_id ?? null, delivered: 'photo' };
        }
      }
      const result = await call('sendMessage', { chat_id: resolved.chatId, text: caption });
      diagnostics.notified++;
      return { ok: true, messageId: result?.message_id ?? null, delivered: 'text' };
    },
    // Long polling: no public webhook is required. Only the configured chat AND
    // user are accepted; anything else is counted and ignored.
    async poll({ limit = 10 } = {}) {
      const resolved = await resolveConfig();
      requireThat(resolved.ok, `telegram_unavailable:${resolved.code}`);
      const updates = await call('getUpdates', { offset, limit, timeout: 0, allowed_updates: ['message'] });
      const accepted = [];
      for (const update of updates || []) {
        offset = Math.max(offset, (update.update_id || 0) + 1);
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
      return accepted;
    },
  };
}
