import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsFromJournalLines } from '../lib/journal.mjs';

const DECISION = {
  schema: 'buena.browser-decision.record/1',
  kind: 'decision',
  at: '2026-09-25T15:00:00.000Z',
  jobId: 'job-1',
  decisionId: 'dec_1',
  phase: 'login',
  stateClass: 'login_form',
  candidates: [{ id: 'e1', tool: 'fill_username' }, { id: 'e2', tool: 'submit_login' }],
  chosen: { id: 'e1', tool: 'fill_username' },
  recommendations: { deterministic: { top1: 'e1', agreed: true }, jev: null, valen: null },
  source: 'deterministic',
};

test('a verified receipt yields VERIFIED_SUCCESSFUL_ACTION with the operation as target', () => {
  const [record] = recordsFromJournalLines([
    DECISION,
    { kind: 'receipt', decisionId: 'dec_1', at: '2026-09-25T15:00:01.000Z', operation: 'fill_username',
      receipt: { state: 'verified', postconditionMet: true }, label_quality: 'VERIFIED_SUCCESSFUL_ACTION' },
  ]);
  assert.equal(record.label_quality, 'VERIFIED_SUCCESSFUL_ACTION');
  assert.equal(record.label.target_action, 'fill_username');
  assert.equal(record.outcome.verified, true);
  assert.equal(record.provenance.source, 'decision-journal');
});

test('a verified recovery receipt yields VERIFIED_RECOVERY_ACTION', () => {
  const [record] = recordsFromJournalLines([
    { ...DECISION, phase: 'jev_recovery', decisionId: 'dec_r' },
    { kind: 'receipt', decisionId: 'dec_r', operation: 'retry_observation',
      receipt: { state: 'verified', postconditionMet: true }, label_quality: 'VERIFIED_RECOVERY_ACTION' },
  ]);
  assert.equal(record.label_quality, 'VERIFIED_RECOVERY_ACTION');
  assert.equal(record.label.target_action, 'retry_observation');
});

test('a failed receipt is a negative, never a target', () => {
  const [record] = recordsFromJournalLines([
    DECISION,
    { kind: 'receipt', decisionId: 'dec_1', operation: 'submit_login', receipt: { state: 'failed', postconditionMet: false } },
  ]);
  assert.equal(record.label_quality, 'FAILED_ACTION');
  assert.equal(record.label, undefined);
  assert.equal(record.attempted_action, 'fill_username');
});

test('a dispatched outcome alone is OBSERVED, and nothing stronger is AMBIGUOUS', () => {
  const [dispatched] = recordsFromJournalLines([
    DECISION,
    { kind: 'outcome', decisionId: 'dec_1', outcome: { status: 'success', verified: true } },
  ]);
  assert.equal(dispatched.label_quality, 'OBSERVED_SUCCESSFUL_ACTION');
  const [nothing] = recordsFromJournalLines([DECISION]);
  assert.equal(nothing.label_quality, 'AMBIGUOUS');
});

test('a cleared human checkpoint is the only security label, with the escalation target', () => {
  const pending = { kind: 'human_checkpoint', decisionId: 'dec_1', at: '2026-09-25T15:00:02.000Z', reason: 'human_verification_required',
    human_escalation: { kind: 'security_checkpoint', target_action: 'escalate_security_checkpoint', raised_at: '2026-09-25T15:00:02.000Z' } };
  const cleared = { kind: 'human_checkpoint_cleared', decisionId: 'dec_1', at: '2026-09-25T15:05:00.000Z', reason: 'human_verification_required',
    human_escalation: { kind: 'security_checkpoint', target_action: 'escalate_security_checkpoint', cleared_at: '2026-09-25T15:05:00.000Z', post_clear_verification: { status: 'verified' } } };
  const [record] = recordsFromJournalLines([DECISION, pending, cleared]);
  assert.equal(record.label_quality, 'VERIFIED_HUMAN_ESCALATION');
  assert.equal(record.label.target_action, 'escalate_security_checkpoint');
  assert.equal(record.human_escalation.kind, 'security_checkpoint');
  assert.equal(record.human_escalation.post_clear_verification.status, 'verified');

  const [uncleared] = recordsFromJournalLines([DECISION, pending]);
  assert.equal(uncleared.label_quality, 'AMBIGUOUS');
  assert.equal(uncleared.label, undefined);
});

test('journal secrets are dropped before corpus admission', () => {
  const [record] = recordsFromJournalLines([
    { ...DECISION, cookie: 'session=abc', candidates: [{ id: 'e1', tool: 'fill_username' }] },
  ]);
  assert.equal(record.cookie, undefined);
});
