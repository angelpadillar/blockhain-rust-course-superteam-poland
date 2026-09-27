import { existsSync } from 'node:fs';
import { createDiscordNotifier, defaultDiscordWebhookPath } from './discord-notifier.mjs';

// The private directory is mounted at /data inside the worker container, so the
// webhook lives at a different path there than on the host.
const RUNTIME_WEBHOOK_PATH = existsSync('/data') ? '/data/discord-webhook-url' : defaultDiscordWebhookPath;

/**
 * Discord alert for a genuine human checkpoint. Never blocks the operation and
 * never throws: when the webhook is not provisioned it returns a hint instead.
 *
 * The webhook URL lives at `defaultDiscordWebhookPath` (mode 600) or in
 * DISCORD_WEBHOOK_URL; see src/discord-notifier.mjs.
 */
export async function notifyHuman({
  label = null,
  state = 'WAITING_FOR_HUMAN',
  reason = null,
  url = null,
  screenshotPath = null,
  resumeCommand = null,
  visibleText = null,
  webhookPath = RUNTIME_WEBHOOK_PATH,
} = {}) {
  try {
    const notifier = createDiscordNotifier({ webhookPath });
    if (!(await notifier.available())) {
      return {
        sent: false,
        reason: 'discord_webhook_not_configured',
        hint: `write the Discord webhook URL to ${webhookPath} (mode 600) or set DISCORD_WEBHOOK_URL`,
      };
    }
    const result = await notifier.notify({
      checkpoint: {
        id: `human-${Date.now()}`,
        jobId: label || 'account',
        profileRef: label || null,
        reason,
        createdAt: new Date().toISOString(),
      },
      label,
      url,
      state,
      screenshotPath,
      resumeCommand,
      visibleText,
    });
    return { sent: true, delivered: result.delivered, attachments: result.attachments, messageId: result.messageId };
  } catch (error) {
    return { sent: false, reason: String(error?.message ?? error).slice(0, 160) };
  }
}
