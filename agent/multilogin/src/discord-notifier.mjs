import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PilotError, requireThat } from './core.mjs';
import { loadSecret } from './frontier.mjs';

// Discord webhook notifier. It replaces Telegram as the operator alert channel:
// plain outgoing webhooks, no bot, no long poll, no interactive dependency.
// Webhook credentials come from the environment or a mode-600 private file and
// are never written to a job file, log or report.
export const defaultDiscordWebhookPath = '/opt/buena-multilogin/private/discord-webhook-url';
export const discordWebhookPattern = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,}\/[\w-]{20,}$/;
export const maxAttachmentBytes = 7_500_000;
export const defaultResumeTemplate = 'npm run browser:job -- jobs/<job-id>.json';

export function maskWebhook(url) {
  if (typeof url !== 'string' || !url) return 'none';
  const match = /\/webhooks\/(\d+)\//.exec(url);
  return match ? `webhook:…${match[1].slice(-4)}` : 'webhook:configured';
}

export function buildCheckpointMessage({ checkpoint = {}, label = null, state = 'WAITING_FOR_HUMAN',
  reason = null, url = null, timestamp = null, recovery = null, visibleText = null,
  resumeCommand = null } = {}) {
  const lines = [
    '**HUMAN VERIFICATION REQUIRED**',
    `job: \`${checkpoint.jobId ?? 'unknown'}\``,
    `profile: ${label || checkpoint.profileRef || checkpoint.accountRef || 'unknown'}`,
    `state: ${state}`,
    `reason: ${reason || checkpoint.reason || 'human_verification_required'}`,
    url ? `page: ${url}` : null,
    `time: ${timestamp || checkpoint.createdAt || new Date().toISOString()}`,
    recovery ? `recovery: ${recovery.steps ?? 0}/${recovery.budget ?? 0} steps used` : null,
    visibleText ? `visible text: ${String(visibleText).slice(0, 300)}` : null,
    `checkpoint: \`${checkpoint.id ?? 'pending'}\``,
    `expires: ${checkpoint.expiresAt ?? 'n/a'}`,
    `same profile preserved: yes`,
    resumeCommand ? `resume: \`${resumeCommand}\`` : null,
  ].filter(Boolean);
  return lines.join('\n').slice(0, 1900);
}

// Bounded, non-destructive delivery. A webhook failure is reported; it never
// touches the browser, the profile or the checkpoint record on disk.
export function createDiscordNotifier({ webhookPath = defaultDiscordWebhookPath, webhookUrl = null,
  secretLoader = loadSecret, fetchImpl = fetch, timeoutMs = 25000, now = Date.now,
  maxRetries = 2, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  environment = process.env } = {}) {
  requireThat(typeof fetchImpl === 'function', 'discord_fetch_required');
  let resolved = null;
  const diagnostics = { notified: 0, retries: 0, failures: 0, rejected: 0, lastError: null,
    attachments: 0, masked: null, lastDelivery: null };

  const resolveWebhook = async () => {
    if (resolved) return resolved;
    if (typeof webhookUrl === 'string' && webhookUrl) {
      requireThat(discordWebhookPattern.test(webhookUrl), 'invalid_discord_webhook');
      resolved = { ok: true, url: webhookUrl }; return resolved;
    }
    const fromEnvironment = environment.DISCORD_WEBHOOK_URL;
    if (typeof fromEnvironment === 'string' && fromEnvironment) {
      requireThat(discordWebhookPattern.test(fromEnvironment), 'invalid_discord_webhook');
      resolved = { ok: true, url: fromEnvironment }; diagnostics.masked = maskWebhook(fromEnvironment);
      return resolved;
    }
    const secret = await secretLoader(webhookPath);
    if (!secret?.ok) { resolved = { ok: false, code: `webhook_${secret?.code || 'missing'}` }; return resolved; }
    let url = String(secret.value).trim();
    // Common operator paste: some stores wrap the URL as DISCORD_WEBHOOK_URL=...
    const assignment = /^DISCORD_WEBHOOK_URL=(.+)$/.exec(url);
    if (assignment) url = assignment[1].trim();
    if (!discordWebhookPattern.test(url)) { resolved = { ok: false, code: 'invalid_discord_webhook' }; return resolved; }
    resolved = { ok: true, url }; diagnostics.masked = maskWebhook(url);
    return resolved;
  };

  const post = async (formOrBody, { wait = false } = {}) => {
    const target = await resolveWebhook();
    requireThat(target.ok, `discord_unavailable:${target.code}`);
    const suffix = wait ? '?wait=true' : '';
    let attempt = 0;
    for (;;) {
      attempt++;
      let response;
      try {
        response = await fetchImpl(`${target.url}${suffix}`, { method: 'POST', redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
          ...(formOrBody instanceof FormData ? { body: formOrBody } : {
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formOrBody) }) });
      } catch (error) {
        diagnostics.lastError = error?.code || error?.name || 'network';
        if (attempt <= maxRetries) { diagnostics.retries++; await sleep(500 * attempt); continue; }
        diagnostics.failures++; throw new PilotError('discord_unreachable');
      }
      if (response.status === 429 && attempt <= maxRetries) {
        const payload = await response.json().catch(() => null);
        const retryAfter = Number(payload?.retry_after);
        diagnostics.retries++;
        await sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5000) : 1000);
        continue;
      }
      if (response.status >= 500 && attempt <= maxRetries) {
        diagnostics.retries++;
        await sleep(750 * attempt);
        continue;
      }
      if (response.status === 204 || response.status === 200) {
        const payload = response.status === 200 ? await response.json().catch(() => null) : null;
        diagnostics.notified++;
        return { messageId: payload?.id ?? null };
      }
      diagnostics.lastError = `http_${response.status}`;
      diagnostics.rejected++;
      diagnostics.failures++;
      throw new PilotError(`discord_webhook_rejected:http_${response.status}`);
    }
  };

  return {
    name: 'discord',
    diagnostics,
    async available() { return (await resolveWebhook()).ok; },
    async status() {
      const target = await resolveWebhook();
      return target.ok ? { notifier: 'discord', state: 'available', webhook: maskWebhook(target.url) }
        : { notifier: 'discord', state: 'unavailable', code: target.code };
    },
    resumeCommandFor(jobId) { return (defaultResumeTemplate).replaceAll('<job-id>', String(jobId || 'job')); },
    // Files: the canonical viewport PNG (and the focused region when present).
    // Content is built by the caller from checkpoint/context metadata only.
    async notify({ checkpoint = {}, screenshotPath = null, regionPath = null, content = null,
      label = null, url = null, visibleText = null, recovery = null, resumeCommand = null,
      state = 'WAITING_FOR_HUMAN' } = {}) {
      requireThat(checkpoint?.id || checkpoint?.jobId, 'checkpoint_required');
      const message = content || buildCheckpointMessage({ checkpoint, label, state, url,
        recovery, visibleText, resumeCommand });
      const attachments = [];
      for (const path of [screenshotPath || checkpoint.screenshot, regionPath]) {
        if (!path) continue;
        const bytes = await readFile(path).catch(() => null);
        if (!bytes || bytes.length === 0 || bytes.length > maxAttachmentBytes) continue;
        attachments.push({ name: basename(String(path)), bytes });
      }
      if (!attachments.length) {
        const result = await post({ content: message, allowed_mentions: { parse: [] } }, { wait: true });
        diagnostics.lastDelivery = 'text';
        return { ok: true, delivered: 'text', attachments: 0, messageId: result.messageId };
      }
      const form = new FormData();
      form.set('payload_json', JSON.stringify({ content: message,
        attachments: attachments.map((attachment, index) => ({ id: String(index), filename: attachment.name })),
        allowed_mentions: { parse: [] } }));
      attachments.forEach((attachment, index) => {
        form.set(`files[${index}]`, new Blob([attachment.bytes], { type: attachment.name.endsWith('.png')
          ? 'image/png' : 'application/octet-stream' }), attachment.name);
      });
      const result = await post(form, { wait: true });
      diagnostics.attachments += attachments.length;
      diagnostics.lastDelivery = 'files';
      return { ok: true, delivered: 'files', attachments: attachments.length, messageId: result.messageId };
    },
    async send({ text } = {}) {
      requireThat(typeof text === 'string' && text.length > 0, 'discord_message_required');
      const result = await post({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }, { wait: true });
      diagnostics.lastDelivery = 'text';
      return { ok: true, messageId: result.messageId };
    },
  };
}
