import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateContactVault, readPrivateJson, writePrivateJson } from './private-store.mjs';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'delio-private-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('vault binds its persisted owner, permits only known contact slots and exposes secrets only through callbacks', async t => {
  const dir = await directory(t), owner = 'fixture-owner';
  const vault = createPrivateContactVault({ dir, customerId: owner });
  await vault.put(owner, 'activationEmail', 'fixture-activation@example.test');
  await assert.rejects(vault.put('another-owner', 'activationEmail', 'other@example.test'), /private_contact_not_owned/);
  await assert.rejects(vault.withSecret('another-owner', 'activationEmail', () => assert.fail()), /private_contact_not_owned/);
  await assert.rejects(vault.put(owner, 'arbitrarySlot', 'anything'), /private_contact_not_owned/);
  await assert.rejects(vault.withSecret(owner, 'activationOtp', () => assert.fail()), /private_contact_unavailable/);
  let observed;
  const returned = await vault.withSecret(owner, 'activationEmail', value => { observed = value; return value; });
  assert.equal(observed, 'fixture-activation@example.test'); assert.equal(returned, undefined);
  assert.deepEqual(Object.keys(vault).sort(), ['put', 'withSecret']);
  const reopened = createPrivateContactVault({ dir, customerId: owner });
  await reopened.withSecret(owner, 'activationEmail', value => assert.equal(value, observed));
  assert.throws(() => createPrivateContactVault({ dir, customerId: 'another-owner' }), /vault_owner_mismatch/);
  assert.equal((await stat(join(dir, 'contacts.json'))).mode & 0o777, 0o600);
});

test('invalid owner types are rejected rather than coerced into an apparent identity', async t => {
  const dir = await directory(t);
  for (const customerId of [undefined, null, 123, '', '../other']) {
    assert.throws(() => createPrivateContactVault({ dir, customerId }), /invalid_vault_owner/);
  }
});

test('a failed durable replacement never exposes an uncommitted contact through the live vault', async t => {
  const dir = await directory(t), owner = 'fixture-owner';
  const vault = createPrivateContactVault({ dir, customerId: owner });
  await vault.put(owner, 'activationEmail', 'persisted@example.test');
  await mkdir(join(dir, 'contacts.json.next'));
  await assert.rejects(vault.put(owner, 'activationEmail', 'uncommitted@example.test'));
  let exposed;
  try { await vault.withSecret(owner, 'activationEmail', value => { exposed = value; }); } catch { /* Poisoned vault is also safe. */ }
  assert.notEqual(exposed, 'uncommitted@example.test');
  const reopened = createPrivateContactVault({ dir, customerId: owner });
  await reopened.withSecret(owner, 'activationEmail', value => assert.equal(value, 'persisted@example.test'));
});

test('private JSON replacement persists complete snapshots and malformed JSON fails closed', async t => {
  const dir = await directory(t), file = join(dir, 'snapshot.json');
  assert.equal(readPrivateJson(file, null), null);
  writePrivateJson(file, { version: 1, fixture: true });
  writePrivateJson(file, { version: 2, fixture: false });
  assert.deepEqual(readPrivateJson(file), { version: 2, fixture: false });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
  await writeFile(file, '{malformed-fixture-json');
  assert.throws(() => readPrivateJson(file), /private_store_invalid/);
});
