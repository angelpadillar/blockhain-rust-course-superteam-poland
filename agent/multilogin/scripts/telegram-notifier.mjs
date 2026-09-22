// Telegram notifier CLI for the human-checkpoint loop. Long polling only: no
// public webhook. Numeric chat/user ids are written to private files and are
// printed masked, never in full.
//
//   node scripts/telegram-notifier.mjs bootstrap [--directory DIR]
//   node scripts/telegram-notifier.mjs poll [--seconds 60] [--directory DIR]
//   node scripts/telegram-notifier.mjs send --text "..." 
//   node scripts/telegram-notifier.mjs notify-checkpoint --job DIR
import { chmod, chown, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { errorCode, requireThat } from '../src/core.mjs';
import { createTelegramNotifier, createCheckpointStore, handleCommand, countActiveCheckpoints,
  defaultTelegramTokenPath, defaultTelegramChatIdPath, defaultTelegramUserIdPath } from '../src/human-checkpoint.mjs';

const mask = value => (typeof value === 'string' && value.length > 3 ? `…${value.slice(-3)}` : 'none');
const flag = (argv, name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

async function bootstrap({ argv }) {
  const notifier = createTelegramNotifier();
  const status = await notifier.status();
  if (status.state !== 'available') {
    console.log(JSON.stringify({ step: 'bootstrap', status, hint: 'provision the private secret files with mode 600' }));
    return status.state === 'available' ? 0 : 1;
  }
  // Read updates without confirming them, so a later poll can still answer them.
  const response = await fetch(`https://api.telegram.org/bot${(await readFile(defaultTelegramTokenPath, 'utf8')).trim()}/getUpdates`);
  const payload = await response.json();
  const messages = (payload?.result || []).map(update => update.message).filter(Boolean);
  if (!messages.length) {
    const webhook = await fetch(`https://api.telegram.org/bot${(await readFile(defaultTelegramTokenPath, 'utf8')).trim()}/getWebhookInfo`)
      .then(result => result.json()).catch(() => null);
    console.log(JSON.stringify({ step: 'bootstrap', updates: 0,
      webhook: webhook?.result ? { url: webhook.result.url || null,
        pending: webhook.result.pending_update_count ?? null,
        error: webhook.result.last_error_message || null } : null,
      hint: 'no pending updates: send /start to the bot from the allowlisted account' }, null, 2));
    return 1;
  }
  const chatId = String(messages.at(-1).chat.id);
  const userId = String(messages.at(-1).from.id);
  await writeFile(defaultTelegramChatIdPath, chatId, { mode: 0o600 });
  await writeFile(defaultTelegramUserIdPath, userId, { mode: 0o600 });
  await chmod(defaultTelegramChatIdPath, 0o600); await chmod(defaultTelegramUserIdPath, 0o600);
  // The container runtime is uid 1000; keep the files private but readable by it.
  const uid = Number(flag(argv, 'uid', '1000'));
  await chown(defaultTelegramChatIdPath, uid, uid).catch(() => {});
  await chown(defaultTelegramUserIdPath, uid, uid).catch(() => {});
  console.log(JSON.stringify({ step: 'bootstrap', updates: messages.length,
    chat: mask(chatId), user: mask(userId), text: (messages.at(-1).text || '').slice(0, 12) }));
  return 0;
}

async function poll({ argv }) {
  const seconds = Number(flag(argv, 'seconds', '60'));
  const directory = flag(argv, 'directory');
  const notifier = createTelegramNotifier();
  const store = directory ? createCheckpointStore({ directory }) : null;
  const deadline = Date.now() + seconds * 1000;
  const handled = [];
  while (Date.now() < deadline) {
    let commands = [];
    try { commands = await notifier.poll(); }
    catch (error) { console.log(JSON.stringify({ step: 'poll', error: errorCode(error) })); await sleep(2000); continue; }
    for (const parsed of commands) {
      const checkpoint = store ? await store.load() : null;
      const outcome = await handleCommand({ parsed, notifier, store,
        loadCheckpoint: async id => (checkpoint && checkpoint.id === id ? checkpoint : null),
        loadActive: async () => (directory ? countActiveCheckpoints({ directory }) : { active: 0 }),
        verify: null });
      handled.push({ command: parsed.command, action: outcome.action });
    }
    await sleep(2000);
  }
  console.log(JSON.stringify({ step: 'poll', seconds, handled,
    unauthorizedSender: notifier.diagnostics.unauthorizedSender }));
  return 0;
}

async function send({ argv }) {
  const text = flag(argv, 'text');
  requireThat(text, 'text_required');
  const notifier = createTelegramNotifier();
  const result = await notifier.send({ text });
  console.log(JSON.stringify({ step: 'send', delivered: true, messageId: result.messageId }));
  return 0;
}

async function notifyCheckpoint({ argv }) {
  const jobDirectory = flag(argv, 'job');
  requireThat(jobDirectory, 'job_required');
  const notifier = createTelegramNotifier();
  const checkpoint = JSON.parse(await readFile(resolve(jobDirectory, 'human-checkpoint.json'), 'utf8'));
  const result = await notifier.notify({ checkpoint });
  console.log(JSON.stringify({ step: 'notify_checkpoint', delivered: result.delivered,
    messageId: result.messageId, checkpoint: checkpoint.id }));
  return 0;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const commands = { bootstrap, poll, send, 'notify-checkpoint': notifyCheckpoint };
const argv = process.argv.slice(2);
const name = argv[0];
try {
  requireThat(commands[name], 'unknown_command');
  process.exitCode = await commands[name]({ argv });
} catch (error) {
  console.log(JSON.stringify({ step: name || 'none', status: 'stopped', reason: errorCode(error) }));
  process.exitCode = 1;
}
