import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWorkflow } from './planner.mjs';

test('one planning call compiles merchant then item without answer data', async () => {
  let count = 0;
  const plan = await compileWorkflow({ goal: 'Search for Cedar Stationery, then find Maple Notebook and open it.',
    complete: async request => {
      count++;
      assert.equal(request.purpose, 'plan');
      assert.deepEqual(Object.keys(request.input), ['request']);
      assert(!JSON.stringify(request).includes('expectedUrl'));
      return { steps: [
        { operation: 'search_and_open', query: 'Cedar Stationery', targetText: 'Cedar Stationery', context: '' },
        { operation: 'search_and_open', query: 'Maple Notebook', targetText: 'Maple Notebook', context: '' },
      ] };
    } });
  assert.equal(count, 1); assert.equal(plan.steps.length, 2);
});

test('invalid extra fields and unsupported tasks stop rather than silently shrink', async () => {
  for (const answer of [
    { steps: [], explanation: 'rejected' }, { steps: [] },
    { steps: [{ operation: 'open_link', query: 'extra', targetText: 'Book', context: '' }] },
    { steps: [{ operation: 'open_link', query: '', targetText: 'Book', context: '', expectedUrl: '/answer' }] },
    { steps: [{ operation: 'buy', query: '', targetText: 'Book', context: '' }] },
  ]) {
    await assert.rejects(compileWorkflow({ goal: 'Unsupported task', complete: async () => answer }));
  }
});
