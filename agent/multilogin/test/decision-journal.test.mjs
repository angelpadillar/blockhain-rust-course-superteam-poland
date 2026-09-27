import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecisionJournal, decisionJournalName, labelForOutcome, pseudonymizeProfile, sanitizeForJournal } from '../src/decision-journal.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'decision-journal-'));
}

function readRecords(dir) {
  return readFileSync(join(dir, decisionJournalName), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('high-quality labels require a verified receipt', () => {
  assert.equal(labelForOutcome({ phase: 'login', receipt: null }), 'AMBIGUOUS');
  assert.equal(labelForOutcome({ phase: 'login', receipt: { state: 'dispatched', postconditionMet: null } }), 'AMBIGUOUS');
  assert.equal(labelForOutcome({ phase: 'login', receipt: { state: 'failed', postconditionMet: false } }), 'FAILED_ACTION');
  assert.equal(labelForOutcome({ phase: 'login', receipt: { state: 'verified', postconditionMet: true } }), 'VERIFIED_SUCCESSFUL_ACTION');
  assert.equal(labelForOutcome({ phase: 'jev_recovery', receipt: { state: 'verified', postconditionMet: true } }), 'VERIFIED_RECOVERY_ACTION');
});

test('secret keys and values never enter the journal', () => {
  const counters = { dropped: 0 };
  const sanitized = sanitizeForJournal({
    cookie: 'session=abc',
    authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
    note: 'https://discord.com/api/webhooks/1/abcdef',
    proxy_url: 'socks5://user:pass@host:1080',
    ok: 'keep',
    nested: { apiKey: 'x', value: 1 },
  }, counters);
  assert.equal(sanitized.cookie, undefined);
  assert.equal(sanitized.authorization, undefined);
  assert.equal(sanitized.proxy_url, undefined);
  assert.equal(sanitized.note, '[redacted]');
  assert.equal(sanitized.ok, 'keep');
  assert.equal(sanitized.nested.apiKey, undefined);
  assert.equal(sanitized.nested.value, 1);
  assert.ok(counters.dropped >= 4);
});

test('decisions, executions, receipts and outcomes are append-only and labelled from receipts', async () => {
  const dir = tempDir();
  try {
    const journal = createDecisionJournal({ directory: dir, jobId: 'job-1', platform: 'youtube', accountRef: 'yt-1', profileRef: 'raw-profile-1' });
    await journal.decision({ phase: 'login', step: 0, stateClass: 'login_form',
      candidates: [{ id: 'e1', tool: 'fill_username' }, { id: 'e2', tool: 'submit_login' }],
      chosen: { id: 'e1', tool: 'fill_username' }, method: 'exact-single-match', topCandidate: 'e1', agreed: true, source: 'deterministic' });
    await journal.execution({ phase: 'login', action: 'fill_username', result: 'selected' });
    await journal.receipt({ operation: 'fill_username', state: 'verified', postconditionMet: true, decisionSource: 'deterministic' });
    const records = readRecords(dir);
    assert.equal(records.length, 3);
    assert.equal(records[0].kind, 'decision');
    assert.equal(records[0].executable, false);
    assert.equal(records[0].profileId.startsWith('prof_'), true);
    assert.equal(records[1].kind, 'execution');
    assert.equal(records[2].kind, 'receipt');
    assert.equal(records[2].label_quality, 'VERIFIED_SUCCESSFUL_ACTION');
    assert.equal(records[2].label.target_action, 'fill_username');
    assert.equal(journal.summary.decisions, 1);
    assert.equal(journal.summary.outcomes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing writer disables the journal but never throws', async () => {
  const dir = tempDir();
  try {
    const journal = createDecisionJournal({ directory: dir, jobId: 'job-2' });
    // Simulate an unwritable directory by replacing the journal directory with a file.
    rmSync(dir, { recursive: true, force: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dir, 'not a directory');
    await assert.doesNotReject(() => journal.decision({ phase: 'login', candidates: [{ id: 'a', tool: 'a' }], chosen: { id: 'a', tool: 'a' } }));
    await assert.doesNotReject(() => journal.receipt({ operation: 'a', state: 'verified', postconditionMet: true }));
    assert.equal(journal.summary.disabled, true);
    assert.ok(journal.summary.failures >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('security checkpoints are never labelled before a human clears them', async () => {
  const dir = tempDir();
  try {
    const journal = createDecisionJournal({ directory: dir, jobId: 'job-3' });
    await journal.checkpointPending({ reason: 'human_verification_required' });
    let records = readRecords(dir);
    assert.equal(records[0].kind, 'human_checkpoint');
    assert.equal(records[0].label_quality, 'AMBIGUOUS');
    assert.equal(records[0].human_escalation.target_action, 'escalate_security_checkpoint');
    assert.equal(records[0].label, undefined);
    // A cleared event without verified post-clear state emits nothing.
    assert.equal(await journal.checkpointCleared({ reason: 'human_verification_required', postClearVerified: false }), null);
    await journal.checkpointCleared({ reason: 'human_verification_required', postClearVerified: true });
    records = readRecords(dir);
    assert.equal(records[1].kind, 'human_checkpoint_cleared');
    assert.equal(records[1].label_quality, 'VERIFIED_HUMAN_ESCALATION');
    assert.equal(records[1].label.target_action, 'escalate_security_checkpoint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile ids stay pseudonymous and stable', () => {
  assert.equal(pseudonymizeProfile('raw-1'), pseudonymizeProfile('raw-1'));
  assert.notEqual(pseudonymizeProfile('raw-1'), pseudonymizeProfile('raw-2'));
  assert.match(pseudonymizeProfile('raw-1'), /^prof_[0-9a-f]{16}$/);
});
