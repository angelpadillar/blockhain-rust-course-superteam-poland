// Announce the human checkpoint a job is currently waiting on. This is the
// operator's handoff step: it binds the frame the job already captured to a
// durable checkpoint record and sends the Telegram alert.
//
//   node scripts/checkpoint-announce.mjs --job /data/account-pilot/jobs/youtube-live-04
//                                       [--seconds 1800] [--reason R] [--dry-run]
//
// The screenshot is the job's own captureSafeScreenshot output: it is never
// re-captured, resized or re-encoded. The alert is a sendPhoto preview plus the
// byte-identical original PNG as a document, and it carries the checkpoint,
// job, account, profile and expiry. A repeated announce for a checkpoint that is
// already waiting reuses that record instead of sending a second alert.
import { errorCode } from '../src/core.mjs';
import { announceCheckpoint } from '../src/human-checkpoint.mjs';
import { createDiscordNotifier } from '../src/discord-notifier.mjs';

const flag = (argv, name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const argv = process.argv.slice(2);
try {
  const directory = flag(argv, 'job');
  if (!directory) throw new Error('job_required');
  const dryRun = argv.includes('--dry-run');
  const { checkpoint, delivery, repeated } = await announceCheckpoint({ directory,
    notifier: dryRun ? null : createDiscordNotifier(flag(argv, 'webhook-file')
      ? { webhookPath: flag(argv, 'webhook-file') } : {}),
    persist: !dryRun,
    seconds: Number(flag(argv, 'seconds', '1800')), reason: flag(argv, 'reason', null),
    label: flag(argv, 'label', null), resumeCommand: flag(argv, 'resume-command', null) });
  console.log(JSON.stringify({ step: 'announce', dryRun, repeated,
    checkpoint: { id: checkpoint.id, jobId: checkpoint.jobId, accountRef: checkpoint.accountRef,
      profileRef: checkpoint.profileRef, reason: checkpoint.reason, state: checkpoint.state,
      expiresAt: checkpoint.expiresAt, screenshot: checkpoint.screenshot },
    previewMessageId: delivery?.previewMessageId ?? delivery?.messageId ?? null,
    documentMessageId: delivery?.documentMessageId ?? null,
    documentName: delivery?.documentName ?? null,
    delivered: delivery?.delivered ?? null,
    documentError: delivery?.documentError ?? null }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error), detail: error.message }));
  process.exitCode = 1;
}
