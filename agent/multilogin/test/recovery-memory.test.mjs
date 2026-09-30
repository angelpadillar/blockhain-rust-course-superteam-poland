import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecoveryMemory, memoryStateFor, maxRecalledEpisodes } from '../src/recovery-memory.mjs';

const scratch = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

test('episodes are compact and carry no page text or credentials', async t => {
  const directory = await scratch(t);
  const memory = createRecoveryMemory({ directory });
  const episode = await memory.record({ reason: 'unexpected_state',
    statePath: 'https://gds.google.com/web/landing', failedAction: 'reopen_account_menu',
    correction: 'navigate_home', verification: 'page_changed', platform: 'youtube', jobId: 'yt-live-04',
    // Unknown fields are dropped, not stored: page text can never leak here.
    pageText: 'Sign in as someone@example.com with code 123456', password: 'private-password',
    cookies: 'session=abc' });
  assert.equal(episode.reason, 'unexpected_state');
  assert.equal(episode.statePath, 'https://gds.google.com/web/landing');
  assert.equal(episode.pageText, undefined);
  assert.equal(episode.password, undefined);
  const raw = await readFile(memory.path, 'utf8');
  assert.equal(raw.includes('someone@example.com'), false);
  assert.equal(raw.includes('123456'), false);
  assert.equal(raw.includes('private-password'), false);
});

test('recall returns a few relevant episodes, most relevant first', async t => {
  const directory = await scratch(t);
  const memory = createRecoveryMemory({ directory });
  await memory.record({ reason: 'human_verification_required', statePath: 'https://accounts.google.com/signin/v2/challenge',
    correction: 'escalate_security_checkpoint', verification: 'unverified' });
  const onMenu = await memory.record({ reason: 'unexpected_state', statePath: 'https://www.youtube.com/',
    failedAction: 'reopen_account_menu', correction: 'navigate_home', verification: 'login_verified' });
  await memory.record({ reason: 'unexpected_state', statePath: 'https://gds.google.com/web/landing',
    correction: 'navigate_home', verification: 'page_changed' });
  const recalled = await memory.recall({ reason: 'unexpected_state', url: 'https://www.youtube.com/feed',
    failedAction: 'reopen_account_menu' });
  assert.ok(recalled.length >= 1 && recalled.length <= maxRecalledEpisodes);
  assert.equal(recalled[0].correction, 'navigate_home');
  assert.equal(recalled[0].failedAction, 'reopen_account_menu');
  // The exact url never enters the memory; only origin+pathname.
  assert.equal(memoryStateFor({ url: 'https://www.youtube.com/feed?token=auth-secret' }).path,
    'https://www.youtube.com/feed');
  const hints = await memory.hints({ reason: 'unexpected_state', url: 'https://www.youtube.com/' });
  assert.ok(hints.every(hint => !hint.includes('auth-secret')));
});

test('markVerified upgrades the corrections that held, and only those', async t => {
  const directory = await scratch(t);
  const memory = createRecoveryMemory({ directory });
  const episode = await memory.record({ reason: 'unexpected_state', statePath: 'https://www.youtube.com/',
    failedAction: 'reopen_account_menu', correction: 'open_switch_account', verification: 'page_changed' });
  await memory.markVerified();
  const all = await memory.all();
  const latest = all.filter(item => item.id === episode.id).at(-1);
  assert.equal(latest.verification, 'login_verified');
  // A second store reading the same file sees the upgraded episode.
  const reader = createRecoveryMemory({ directory });
  const fromDisk = (await reader.all()).filter(item => item.id === episode.id).at(-1);
  assert.equal(fromDisk.verification, 'login_verified');
});

test('a recall without a matching state returns nothing (no memory dump)', async t => {
  const directory = await scratch(t);
  const memory = createRecoveryMemory({ directory });
  await memory.record({ reason: 'account_setup_requires_attention', statePath: 'https://accounts.google.com/',
    correction: 'navigate_home' });
  assert.deepEqual(await memory.recall({ reason: 'totally_unknown_reason', url: 'https://example.invalid/' }), []);
  assert.deepEqual(await memory.hints({ reason: 'totally_unknown_reason' }), []);
});

test('memory telemetry counts recalls, bytes, latency and matches without injecting more', async t => {
  const directory = await scratch(t);
  const memory = createRecoveryMemory({ directory });
  await memory.record({ reason: 'unexpected_state', statePath: 'https://www.youtube.com/',
    failedAction: 'reopen_account_menu', correction: 'navigate_home', verification: 'page_changed' });
  await memory.record({ reason: 'unexpected_state', statePath: 'https://gds.google.com/web/landing',
    correction: 'navigate_home', verification: 'page_changed' });
  const before = { ...memory.diagnostics };
  const recalled = await memory.recall({ reason: 'unexpected_state', url: 'https://www.youtube.com/feed',
    failedAction: 'reopen_account_menu' });
  assert.ok(recalled.length >= 1 && recalled.length <= 2, 'at most two memories are ever recalled');
  assert.equal(memory.diagnostics.calls, before.calls + 1);
  assert.ok(memory.diagnostics.considered >= 1);
  assert.equal(memory.diagnostics.recalled, recalled.length);
  assert.ok(memory.diagnostics.bytes > 0);
  assert.ok(Number.isInteger(memory.diagnostics.retrievalMs) && memory.diagnostics.retrievalMs >= 0);
  assert.equal(typeof memory.diagnostics.lastRecallAt, 'string');
  // The eventual successful correction matched the recalled memory.
  const match = memory.observeCorrection({ correction: 'navigate_home' });
  assert.equal(match.matchedRecall, true);
  assert.equal(memory.diagnostics.corrections, 1);
  assert.equal(memory.diagnostics.matched, 1);
  const miss = memory.observeCorrection({ correction: 'open_switch_account' });
  assert.equal(miss.matchedRecall, false);
  assert.equal(memory.diagnostics.matched, 1, 'a non-matching correction is not counted as a match');
  // An episode written after a matching recall carries the telemetry flag.
  const episode = await memory.record({ reason: 'unexpected_state', statePath: 'https://www.youtube.com/',
    correction: 'navigate_home', verification: 'page_changed', memoryMatched: true });
  assert.equal(episode.memoryMatched, true);
});
