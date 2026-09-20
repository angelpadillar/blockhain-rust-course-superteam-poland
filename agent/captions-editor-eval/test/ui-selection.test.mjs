import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProjection, prepareSelection, evaluateProjection } from '../src/ui-selection.mjs';
const fixture = () => ({ version: 1, observationId: 'fixture-only', capturedAt: new Date().toISOString(), expectedRef: 'e2', candidates: [
  { ref: 'e1', role: 'switch', name: '', labelContext: 'Voiceover Only', checked: false, disabled: false },
  { ref: 'e2', role: 'switch', name: '', labelContext: 'Generate media', checked: true, disabled: false },
  { ref: 'e3', role: 'switch', name: '', labelContext: 'Auto Trim', checked: true, disabled: false },
] });
test('minimal toggle projection validates, expected answer stays outside model state', () => {
  const input = validateProjection(fixture()); const result = prepareSelection(input);
  assert.equal(result.expectedId, 'c1'); assert.equal(result.mapping.c1, 'e2');
  assert.equal(Object.hasOwn(result.state, 'expectedId'), false);
  assert.equal(Object.hasOwn(result.state, 'expectedRef'), false);
  assert.equal(result.state.candidates[1].labelContext, 'Generate media');
});
test('projection rejects whole-page fields, stale evidence, duplicate refs and missing state', () => {
  for (const mutate of [p => p.url = 'https://captions.ai/private', p => p.capturedAt = '2020-01-01T00:00:00Z', p => p.candidates[0].ref = 'e2', p => delete p.candidates[0].checked, p => p.candidates[1].disabled = true]) {
    const p = fixture(); mutate(p); assert.throws(() => validateProjection(p));
  }
});
test('mock evaluation calls the supplied client once and reports actual client fields', async () => {
  let calls = 0;
  const result = await evaluateProjection(validateProjection(fixture()), async state => {
    calls++; assert.equal(state.operation, 'uncheck');
    return { rawChoice: 'c1', choice: 'c1', confidence: 0.91, probabilities: { c0: 0.03, c1: 0.91, c2: 0.03, none: 0.03 }, latencyMs: 123, usage: { input_tokens: 10, output_tokens: 5 } };
  });
  assert.equal(calls, 1); assert.equal(result.passed, true); assert.equal(result.selectedRef, 'e2'); assert.equal(result.browserActions, 0); assert.equal(result.latencyMs, 123);
});
