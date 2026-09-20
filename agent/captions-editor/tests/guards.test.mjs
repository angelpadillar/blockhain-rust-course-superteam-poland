import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, onboardingArgs, fixtureArgs } from '../src/config.mjs';
import { acquireOwner } from '../src/lock.mjs';
import { authorized, createObserver } from '../src/observe-server.mjs';

const base = { initialUrl: 'https://captions.ai/home', stateDir: '/app/state', allowedHosts: ['captions.ai'] };
test('manual mode does not expose file, eval, cookie, proxy, or storage export gates', () => {
  const args = onboardingArgs(validateConfig(base));
  for (const flag of ['--enable-eval', '--allow-file-upload', '--allow-file-download', '--allow-session-export', '--allow-session-import', '--allow-cookie-values', '--allow-session-proxy', '--allow-localhost']) assert.equal(args.includes(flag), false, flag);
  assert.equal(args[args.indexOf('--transport') + 1], 'stdio');
  assert.equal(args[args.indexOf('--toolset') + 1], 'core');
});
test('host configuration rejects broad scopes, secrets, private networks and injected launch settings', () => {
  for (const host of ['*', '.captions.ai', '*.captions.ai', '127.0.0.1', '10.0.0.1', 'https://captions.ai', 'user:secret@captions.ai', 'captions.ai:443', 'localhost', '--enable-eval']) assert.throws(() => validateConfig({ ...base, allowedHosts: [host] }));
  assert.throws(() => validateConfig({ ...base, launchArgs: ['--enable-eval'] }));
  assert.throws(() => validateConfig({ ...base, initialUrl: 'https://captions.ai/billing' }));
});
test('local fixture has a loopback-only scope with only the required file gates', () => {
  const args = fixtureArgs('/tmp/fixture');
  assert.equal(args[args.indexOf('--allowed-hosts') + 1], '127.0.0.1');
  assert(args.includes('--allow-file-upload')); assert(args.includes('--allow-file-download'));
  assert(!args.includes('--enable-eval')); assert(!args.includes('--allow-session-export'));
});
test('exclusive profile ownership fails closed until the owner releases it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'camoufox-lock-'));
  try {
    const release = await acquireOwner(root);
    await assert.rejects(acquireOwner(root), /owner|stale lock/);
    await release(); const second = await acquireOwner(root); await second();
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('observer requires an unguessable token', () => {
  assert(!authorized('Bearer nope', 'x'.repeat(32)));
  assert(authorized('Bearer ' + 'x'.repeat(32), 'x'.repeat(32)));
  assert.throws(() => createObserver({ token: 'short' }), /at least 32/);
});
test('health is unhealthy for a dead runtime or a recorded browser blocker', async () => {
  const token = 'x'.repeat(32);
  for (const status of [{ runtimeAlive: false, status: 'awaiting_manual_login' }, { runtimeAlive: true, status: 'needs_attention' }, { runtimeAlive: true, status: 'failed' }]) {
    const server = createObserver({ token, getStatus: () => status });
    let code; let body;
    const res = { setHeader() {}, writeHead(value) { code = value; }, end(value) { body = JSON.parse(value); } };
    server.emit('request', { method: 'GET', url: '/status', headers: { authorization: `Bearer ${token}` } }, res);
    assert.equal(code, 503); assert.equal(body.healthy, false); server.close();
  }
});
test('select-ready is authenticated and forwards only the bounded JSON contract', async () => {
  const token = 'x'.repeat(32); const calls = [];
  const server = createObserver({ token, bridge: { async selectReady(input) { calls.push(input); return { outcome: 'selected', observations: 2 }; } } });
  async function request(auth) {
    return new Promise(resolve => {
      let status;
      const req = { method: 'POST', url: '/select-ready', headers: { authorization: auth, 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ jobId: 'fixture', waitMs: 5000 })); } };
      const res = { setHeader() {}, writeHead(value) { status = value; }, end(body) { resolve({ status, body: JSON.parse(body) }); } };
      server.emit('request', req, res);
    });
  }
  assert.equal((await request('Bearer wrong')).status, 401); assert.equal(calls.length, 0);
  const result = await request(`Bearer ${token}`);
  assert.equal(result.status, 200); assert.equal(result.body.observations, 2);
  assert.deepEqual(calls, [{ jobId: 'fixture', waitMs: 5000 }]); server.close();
});
