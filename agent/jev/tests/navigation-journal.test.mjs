import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createNavigationJournal, recoverNavigationJournals } from '../src/navigation-journal.mjs';
import { config, temp } from './helpers.mjs';
const task = JSON.parse(await readFile(new URL('../cases/foczka-navigation.json', import.meta.url)));

test('interrupted attempts retain pending events and are marked for inspection without replay', async t => {
  const dataDir = await temp(t);
  const journal = await createNavigationJournal(dataDir, { task, config, environment: 'test', batchId: 'test', run: 1 });
  await journal.record({ type: 'model_request_planned' });
  await journal.record({ type: 'action_planned', action: 'Open product' });
  const before = JSON.parse(await readFile(journal.path));
  assert.equal(before.status, 'running'); assert.equal(before.events.length, 2);
  assert.equal((await stat(journal.path)).mode & 0o777, 0o600);
  assert(!JSON.stringify(before).includes(config.expectedAddress));
  assert.match(before.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(await recoverNavigationJournals(dataDir), 1);
  const after = JSON.parse(await readFile(journal.path));
  assert.equal(after.status, 'interrupted'); assert.deepEqual(after.events, before.events);
  assert.equal(after.result.usageComplete, false); assert.equal(after.result.completionVerified, false);
  assert.equal(await recoverNavigationJournals(dataDir), 0);
});

test('finished failures and successes survive recovery unchanged', async t => {
  const dataDir = await temp(t);
  const journal = await createNavigationJournal(dataDir, { task, config, environment: 'test', batchId: 'test', run: 1 });
  await journal.finish({ status: 'incomplete', reason: 'browser_launch_failed' });
  assert.equal(await recoverNavigationJournals(dataDir), 0);
  assert.equal(JSON.parse(await readFile(journal.path)).result.reason, 'browser_launch_failed');
});
