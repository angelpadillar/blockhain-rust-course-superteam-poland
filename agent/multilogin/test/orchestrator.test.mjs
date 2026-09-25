import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLifecycle } from '../src/lifecycle.mjs';
import { inspectOrchestratorResume, createTelegramCommandLoop, orchestrationExitCode,
  verifyExistingProxyAttachment } from '../src/orchestrator.mjs';
import { createCheckpointStore, createCheckpoint } from '../src/human-checkpoint.mjs';
import { CancelToken } from '../src/jobs.mjs';
import { defaultPaths } from '../job-runner.mjs';
import { parseArguments as parseWrapperArguments, remoteCommands } from '../scripts/job.mjs';

const scratch = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'orchestrator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};
const job = { id: 'yt-live-05', platform: 'youtube', accountRef: 'yt-live-05', profileRef: 'yt-live-05' };

test('restart inspection is read-only and reports the interrupted state and checkpoint', async t => {
  const directory = await scratch(t);
  const empty = await inspectOrchestratorResume({ directory, job });
  assert.equal(empty.resumable, false);
  assert.equal(empty.from, null);
  assert.equal(empty.checkpoint, null);
  const jobDirectory = join(directory, 'jobs', job.id);
  const lifecycle = createLifecycle({ directory: jobDirectory, job });
  await lifecycle.transition('PROFILE_READY');
  await lifecycle.transition('BROWSER_ATTACHED');
  await lifecycle.transition('AUTH_CHECK');
  await lifecycle.transition('LOGIN_IN_PROGRESS');
  await lifecycle.transition('WAITING_FOR_HUMAN', { reason: 'human_verification_required' });
  await lifecycle.finish('WAITING_FOR_HUMAN', { reason: 'human_checkpoint_timeout' });
  await writeFile(join(jobDirectory, 'job.json'), JSON.stringify({ jobId: job.id,
    profileId: '9888f708-e12a-4af4-a6fc-9bda24aaa4c9', state: 'waiting_for_human' }));
  const store = createCheckpointStore({ directory: jobDirectory });
  const checkpoint = createCheckpoint({ jobId: job.id, reason: 'human_verification_required', seconds: 1800 });
  await store.save(checkpoint);
  const resume = await inspectOrchestratorResume({ directory, job });
  assert.equal(resume.resumable, true);
  assert.equal(resume.from, 'WAITING_FOR_HUMAN');
  assert.equal(resume.profileId, '9888f708-e12a-4af4-a6fc-9bda24aaa4c9');
  assert.equal(resume.checkpoint.id, checkpoint.id);
  assert.equal(resume.checkpoint.expired, false);
  assert.equal(resume.jobState, 'waiting_for_human');
});

test('degraded proxy mode proves the attached proxy and refuses anything weaker', async () => {
  const config = { reuseExistingProxy: true };
  const profileId = 'profile-12345678';
  const good = await verifyExistingProxyAttachment({ config, profileId,
    api: { profileMeta: async () => ({ parameters: { proxy: { type: 'socks5', host: 'proxy.invalid', port: 1080 },
      flags: { proxy_masking: 'custom' } } }) } });
  assert.equal(good.attached, true);
  assert.equal(good.proxyPort, 1080);
  assert.equal(good.proxyType, 'socks5');
  // No attached proxy: fail closed; never silently go proxy-less.
  await assert.rejects(verifyExistingProxyAttachment({ config, profileId,
    api: { profileMeta: async () => ({ parameters: { flags: { proxy_masking: 'disabled' } } }) } }),
  /existing_proxy_missing/);
  await assert.rejects(verifyExistingProxyAttachment({ config, profileId,
    api: { profileMeta: async () => null } }), /existing_profile_metadata_unavailable/);
  // No existing profile, or the mode not enabled: refuse before anything starts.
  await assert.rejects(verifyExistingProxyAttachment({ config, profileId: null, api: {} }),
    /reuse_existing_proxy_requires_profile/);
  await assert.rejects(verifyExistingProxyAttachment({ config: {}, profileId, api: {} }),
    /proxy_reuse_not_enabled/);
});

test('job-runner accepts the degraded-proxy switch and forwards it into the config', async () => {
  const { parseArguments: parseJobArguments } = await import('../job-runner.mjs');
  const options = parseJobArguments(['jobs/yt-live-01.example.json', '--reuse-existing-proxy', '--json']);
  assert.equal(options['reuse-existing-proxy'], true);
  assert.deepEqual(options.positional, ['jobs/yt-live-01.example.json']);
});

test('the Telegram loop cancels the job on /cancel and answers /status, never /done as proof', async t => {
  const directory = await scratch(t);
  const jobDirectory = join(directory, 'jobs', job.id);
  await mkdir(jobDirectory, { recursive: true });
  const store = createCheckpointStore({ directory: jobDirectory });
  const checkpoint = createCheckpoint({ jobId: job.id, reason: 'human_verification_required', seconds: 1800 });
  await store.save(checkpoint);
  const replies = [];
  const queued = [
    { recognized: true, command: '/status', checkpointId: checkpoint.id },
    { recognized: true, command: '/done', checkpointId: checkpoint.id },
    { recognized: true, command: '/cancel', checkpointId: checkpoint.id },
  ];
  const notifier = { async poll() { return queued.splice(0, queued.length); },
    async send({ text }) { replies.push(text); return { ok: true }; } };
  const cancel = new CancelToken();
  const events = [];
  const loop = createTelegramCommandLoop({ notifier, directory, cancel, pollMs: 5,
    onEvent: async entry => events.push(entry) });
  await loop.start({ jobId: job.id });
  const deadline = Date.now() + 5000;
  while (!cancel.aborted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  loop.stop();
  assert.equal(cancel.aborted, true);
  assert.equal(cancel.reason, 'cancelled_by_telegram');
  const stored = await store.load();
  assert.equal(stored.state, 'cancelled');
  assert.equal(replies.some(text => text.includes('challenge still present')), true,
    '/done is not accepted as proof while the job cannot re-observe');
  assert.equal(replies.some(text => text.includes('checkpoint cancelled')), true);
  assert.deepEqual(events.filter(entry => entry.phase === 'telegram').map(entry => entry.command),
    ['/status', '/done', '/cancel']);
});

test('exit codes are stable for the operator and scripts', () => {
  assert.equal(orchestrationExitCode({ status: 'completed' }), 0);
  assert.equal(orchestrationExitCode({ status: 'waiting_for_human' }), 2);
  assert.equal(orchestrationExitCode({ status: 'failed' }), 1);
  assert.equal(orchestrationExitCode({ status: 'cancelled' }), 1);
});

test('job-runner defaults resolve from the package when the cwd has no private state', async t => {
  const directory = await scratch(t);
  const resolved = defaultPaths(directory);
  assert.match(resolved.config, /agent\/multilogin\/config\.vps\.json$/);
  assert.match(resolved.accounts, /agent\/multilogin\/private\/accounts\.json$/);
  assert.match(resolved.data, /agent\/multilogin\/private\/state$/);
  // A cwd that owns its private store wins.
  await mkdir(join(directory, 'private'), { recursive: true });
  await writeFile(join(directory, 'config.vps.json'), '{}');
  await writeFile(join(directory, 'private', 'accounts.json'), '[]');
  const local = defaultPaths(directory);
  assert.equal(local.config, join(directory, 'config.vps.json'));
  assert.equal(local.accounts, join(directory, 'private', 'accounts.json'));
});

test('the remote wrapper builds the exact one-command pipeline and never prints a secret', () => {
  const options = parseWrapperArguments(['jobs/yt-live-05.json', '--remote', 'root@example.test',
    '--human-checkpoint-seconds', '1800', '--json']);
  assert.equal(options.remote, 'root@example.test');
  assert.deepEqual(options.positional, ['jobs/yt-live-05.json']);
  assert.deepEqual(options.passthrough, ['--human-checkpoint-seconds', '1800', '--json']);
  const commands = remoteCommands({ host: 'root@example.test', directory: '/opt/buena-multilogin',
    jobFile: 'jobs/yt-live-05.json', jobId: 'yt-live-05', extra: options.passthrough });
  assert.equal(commands.length, 4);
  assert.match(commands[0], /mkdir -p \/opt\/buena-multilogin\/private\/jobs/);
  assert.match(commands[1], /cat jobs\/yt-live-05\.json \| ssh root@example\.test/);
  assert.match(commands[2], /docker compose run --rm --no-deps -T .*--entrypoint node worker job-runner\.mjs/);
  assert.match(commands[2], /-v \/opt\/buena-multilogin-orchestrator\/src:\/app\/src:ro/);
  assert.match(commands[2], /--data \/data\/account-pilot/);
  assert.match(commands[2], /--human-checkpoint-seconds 1800 --json/);
  assert.match(commands[3], /tar -C \/data\/account-pilot\/jobs\/yt-live-05 -czf - \./);
  // File-path flags are fine; a secret VALUE never is.
  for (const command of commands) {
    assert.equal(/Bearer\s|sk-[a-zA-Z0-9]|xoxb-|https:\/\/discord\.com\/api\/webhooks/.test(command), false,
      'the wrapper never embeds a secret value');
    assert.equal(/(MULTILOGIN|TYPESAFE|FIREWORKS)_[A-Z_]*(TOKEN|KEY)=/.test(command), false);
  }
});
