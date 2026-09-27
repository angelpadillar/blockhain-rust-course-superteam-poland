import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionLogger } from '../lib/logger.mjs';
import { SecretRejectedError } from '../lib/schema.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'flywheel-logger-'));
}

test('logger appends canonical records and reads them back', () => {
  const dir = tempDir();
  try {
    const logger = createDecisionLogger({ dir });
    const result = logger.append({
      job_id: 'job-1',
      profile_id: 'raw-profile-abc',
      trajectory_id: 'traj-1',
      timestamp: '2026-09-25T00:00:00.000Z',
      state: { text: 'checkout page', page_class: 'shop.checkout' },
      candidates: ['open_payment_method', 'escalate_security_checkpoint'],
      chosen: 'open_payment_method',
      label_quality: 'AMBIGUOUS',
    });
    assert.match(result.decision_id, /^dec_/);
    assert.match(result.record_hash, /^[0-9a-f]{64}$/);
    const records = logger.readAll();
    assert.equal(records.length, 1);
    assert.equal(records[0].profile_id.startsWith('prof_'), true);
    assert.equal(records[0].chosen, 'open_payment_method');
    assert.equal(records.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logger fails closed on secret material unless redact mode is enabled', () => {
  const dir = tempDir();
  try {
    const strict = createDecisionLogger({ dir });
    assert.throws(
      () =>
        strict.append({
          job_id: 'job-2',
          profile_id: 'p',
          trajectory_id: 't',
          state: { text: 'x', authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
          candidates: ['a', 'b'],
        }),
      SecretRejectedError,
    );

    const redacting = createDecisionLogger({ dir: `${dir}/redacted`, redact: true });
    const result = redacting.append({
      job_id: 'job-3',
      profile_id: 'p',
      trajectory_id: 't',
      state: { text: 'https://discord.com/api/webhooks/1/abcdef', cookie: 'a=b' },
      candidates: ['a', 'b'],
    });
    assert.ok(result.decision_id);
    const written = JSON.parse(readFileSync(redacting.file, 'utf8').trim());
    assert.equal(written.state.text, '[redacted]');
    assert.equal(written.state.cookie, '[redacted]');
    assert.ok(written.redactions.length >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
