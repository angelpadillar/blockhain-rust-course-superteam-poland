import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardSecrets, isHighQuality, isSecurityExample, SecretRejectedError, validateRecord, RecordValidationError, makeDecisionId, pseudonymizeProfile, SCHEMA } from '../lib/schema.mjs';

function baseRecord(overrides = {}) {
  return {
    schema: SCHEMA,
    decision_id: 'dec_test_1',
    job_id: 'job-1',
    profile_id: 'prof_abc',
    trajectory_id: 'traj-1',
    timestamp: '2026-09-25T00:00:00.000Z',
    state: { text: 'state', page_class: 'test.page' },
    candidates: [
      { id: 'click_a', description: 'Click A' },
      { id: 'escalate_to_human', description: 'Escalate' },
    ],
    chosen: 'click_a',
    label_quality: 'AMBIGUOUS',
    ...overrides,
  };
}

test('label taxonomy: only the four verified/curated labels are high quality', () => {
  for (const label of ['CURATED_REQUIRED_ACTION', 'VERIFIED_SUCCESSFUL_ACTION', 'VERIFIED_RECOVERY_ACTION', 'VERIFIED_HUMAN_ESCALATION']) {
    assert.equal(isHighQuality(label), true, label);
  }
  for (const label of ['OBSERVED_SUCCESSFUL_ACTION', 'AMBIGUOUS', 'FAILED_ACTION']) {
    assert.equal(isHighQuality(label), false, label);
  }
});

test('high-quality records must name a target action from the candidate set', () => {
  assert.throws(() => validateRecord(baseRecord({ label_quality: 'VERIFIED_SUCCESSFUL_ACTION' })), RecordValidationError);
  assert.throws(
    () => validateRecord(baseRecord({ label_quality: 'VERIFIED_SUCCESSFUL_ACTION', label: { target_action: 'not_a_candidate' } })),
    RecordValidationError,
  );
  assert.doesNotThrow(() =>
    validateRecord(baseRecord({ label_quality: 'VERIFIED_SUCCESSFUL_ACTION', label: { target_action: 'click_a', basis: 'receipt' } })),
  );
});

test('secret keys and values are rejected by default and redacted on request', () => {
  const withCookie = baseRecord({ state: { text: 'x', cookie: 'session=abc' } });
  assert.throws(() => validateRecord(guardSecrets(withCookie).value), SecretRejectedError);

  const withWebhook = baseRecord({ state: { text: 'https://discord.com/api/webhooks/123/abcdef' } });
  assert.throws(() => guardSecrets(withWebhook), /discord webhook/);

  const { value, redactions } = guardSecrets(withWebhook, { redact: true });
  assert.equal(value.state.text, '[redacted]');
  assert.equal(redactions.length, 1);

  const proxy = baseRecord({ state: { text: 'ok', normalized: { proxy_password: 'hunter2' } } });
  assert.throws(() => guardSecrets(proxy), SecretRejectedError);
  const opRef = baseRecord({ state: { text: 'op://Personal/item/credential' } });
  assert.throws(() => guardSecrets(opRef), /1Password/);
});

test('security records may only teach escalation', () => {
  const solving = baseRecord({
    state: { text: 'captcha', page_class: 'youtube.captcha_challenge' },
    candidates: [{ id: 'solve_captcha', description: 'Solve' }, { id: 'escalate_security_checkpoint', description: 'Escalate' }],
    chosen: 'solve_captcha',
    label_quality: 'CURATED_REQUIRED_ACTION',
    label: { target_action: 'solve_captcha', basis: 'curated_policy' },
  });
  assert.equal(isSecurityExample(solving), true);
  assert.throws(() => validateRecord(solving), /must target an escalation action/);

  const escalating = baseRecord({
    state: { text: 'captcha', page_class: 'youtube.captcha_challenge' },
    candidates: [{ id: 'escalate_security_checkpoint', description: 'Escalate' }],
    chosen: 'escalate_security_checkpoint',
    label_quality: 'CURATED_REQUIRED_ACTION',
    label: { target_action: 'escalate_security_checkpoint', basis: 'curated_policy' },
  });
  assert.doesNotThrow(() => validateRecord(escalating));
});

test('decision ids are stable and profile ids are pseudonymous', () => {
  const material = { trajectory_id: 't', step: 1, timestamp: 'ts', executed_action: 'click_a', candidate_ids: ['click_a'], observation_epoch: 'e1' };
  assert.equal(makeDecisionId(material), makeDecisionId({ ...material }));
  assert.notEqual(makeDecisionId(material), makeDecisionId({ ...material, step: 2 }));
  const first = pseudonymizeProfile('raw-profile-123');
  assert.equal(first, pseudonymizeProfile('raw-profile-123'));
  assert.notEqual(first, pseudonymizeProfile('raw-profile-124'));
  assert.match(first, /^prof_[0-9a-f]{16}$/);
});
