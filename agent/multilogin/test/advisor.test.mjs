import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevAdvisor, createFrontierVisionAdvisor, createAdvisorChain, createStubVision,
  maxVisualEscalations, advisorLevels } from '../src/advisor.mjs';
import { BrowserExecutionKernel } from '../src/execution.mjs';
import { classifyPage, sites } from '../src/login.mjs';

const account = { platform: 'youtube', username: 'fixture@example.com', password: 'private-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };
const site = sites.youtube;

function snapshot({ text = 'Choose how to sign in', controls = null } = {}) {
  return { url: 'https://accounts.google.com/signin/v2/challenge', text, fingerprint: `fp-${text}`,
    challengeFrame: false,
    controls: controls || [
      { key: 'sig-a', tag: 'button', type: '', label: 'Option A', enabled: true },
      { key: 'sig-b', tag: 'button', type: '', label: 'Option B', enabled: true }] };
}

// The workflow operation the login flow would offer for these controls.
function candidates(page) {
  return page.controls.map((control, index) => ({ id: `a${index}`, kind: 'try_another_way', control,
    description: `try_another_way: observed ${control.tag} labelled "${control.label}"` }));
}

function jevChoose({ id = 'a0', confidence = 0.95, method = 'typesafe-choice', fail = null } = {}) {
  const calls = [];
  const choose = async request => {
    calls.push(request);
    if (fail) throw fail;
    return { action: request.actions.find(action => action.id === id) || request.actions[0],
      confidence, probability: 0.9, reason: 'fixture choice', method };
  };
  choose.calls = calls;
  return choose;
}

function visionMock({ actionId = 'a0', abstain = false, confidence = 0.9, fail = null } = {}) {
  const calls = { capture: [], decide: [] };
  return { calls,
    capture: async context => { calls.capture.push(context); return { name: '01-vision.png', id: 'shot-1',
      takenAt: '2026-01-01T00:00:00.000Z' }; },
    decide: async context => { calls.decide.push(context);
      if (fail) throw fail;
      return abstain ? { abstain: true, reason: 'not_sure' } : { actionId, confidence, reason: 'looks like A' }; } };
}

test('L1: one permitted action is decided with no advisor consulted', async () => {
  const jev = createJevAdvisor({ choose: jevChoose() });
  const vision = visionMock();
  const chain = createAdvisorChain({ jev, frontier: createFrontierVisionAdvisor({ vision }) });
  const page = snapshot();
  const [only] = candidates(page);

  const decision = await chain({ page, actions: [only], observation: { epoch: 'epoch-1' } });
  assert.equal(decision.method, 'exact-single-match');
  assert.equal(decision.action.id, 'a0');
  assert.equal(decision.confidence, null, 'no model was asked');
  assert.equal(jev.metrics.calls, 0);
  assert.deepEqual(vision.calls.capture, [], 'no screenshot was taken');
  assert.equal(chain.metrics.deterministic, 1);
});

test('L2: Jev decides when it can, and the answer is one of the permitted candidates', async () => {
  const choose = jevChoose({ id: 'a1' });
  const jev = createJevAdvisor({ choose });
  const vision = visionMock();
  const chain = createAdvisorChain({ jev, frontier: createFrontierVisionAdvisor({ vision }) });
  const page = snapshot();

  const decision = await chain({ page, actions: candidates(page), observation: { epoch: 'epoch-1' } });
  assert.equal(decision.action.id, 'a1');
  assert.equal(decision.method, 'typesafe-choice');
  assert.equal(choose.calls.length, 1);
  assert.deepEqual(vision.calls.capture, [], 'L2 decides without a screenshot');
  assert.equal(chain.metrics.jev, 1);
});

test('a low-confidence Jev answer escalates instead of being accepted', async () => {
  const jev = createJevAdvisor({ choose: jevChoose({ confidence: 0.5 }) });
  const vision = visionMock({ actionId: 'a1' });
  const chain = createAdvisorChain({ jev, frontier: createFrontierVisionAdvisor({ vision }) });
  const page = snapshot();

  const decision = await chain({ page, actions: candidates(page), observation: { epoch: 'epoch-1' } });
  assert.equal(decision.action.id, 'a1', 'the visual escalation decided');
  assert.equal(decision.method, 'frontier-vision');
  assert.equal(jev.metrics.escalated, 1);
  assert.equal(chain.metrics.frontier, 1);
  assert.equal(vision.calls.capture.length, 1);
});

test('a visual escalation takes exactly one fresh screenshot bound to the observation epoch', async () => {
  const vision = visionMock({ actionId: 'a1' });
  const chain = createAdvisorChain({ frontier: createFrontierVisionAdvisor({ vision }) });
  const page = snapshot();
  const observation = { epoch: 'epoch-42', fingerprint: 'fp-page' };

  const decision = await chain({ page, actions: candidates(page), observation });
  assert.equal(vision.calls.capture.length, 1, 'one screenshot per escalation, not one per candidate');
  assert.deepEqual(vision.calls.capture[0], { observation });
  assert.equal(decision.decisionEpoch, 'epoch-42');
  assert.equal(decision.screenshot.epoch, 'epoch-42', 'the screenshot is epoch-bound');
  assert.equal(decision.screenshot.id, '01-vision.png');
  assert.equal(vision.calls.decide[0].permittedActions.length, 2, 'and the decision saw only permitted actions');
});

test('visual escalation is capped per episode, and the cap is three', async () => {
  assert.equal(maxVisualEscalations, 3);
  const vision = visionMock({ actionId: 'a0' });
  const frontier = createFrontierVisionAdvisor({ vision });
  const chain = createAdvisorChain({ frontier });
  const page = snapshot();
  const episode = { escalations: 0 };

  for (let attempt = 0; attempt < maxVisualEscalations; attempt++) {
    const decision = await chain({ page, actions: candidates(page), observation: { epoch: 'e' }, episode });
    episode.escalations = decision.episode.escalations;
    assert.equal(decision.episode.escalations, attempt + 1);
  }
  assert.equal(vision.calls.capture.length, maxVisualEscalations);
  await assert.rejects(chain({ page, actions: candidates(page), observation: { epoch: 'e' }, episode }),
    /no_advisor_decision/);
  assert.equal(vision.calls.capture.length, maxVisualEscalations, 'the fourth escalation never screenshots');
});

test('the frontier interface is unconnected and abstains rather than improvising', async () => {
  const frontier = createFrontierVisionAdvisor();
  const decision = await frontier.advise({ observation: { epoch: 'e' }, permittedActions: [{ id: 'a0' }] });
  assert.deepEqual(decision, { abstained: true, reason: 'frontier_not_configured' });
  assert.deepEqual(await createStubVision().decide({}), { abstain: true, reason: 'frontier_not_configured' });
  assert.equal(advisorLevels.includes('frontier'), true);

  const chain = createAdvisorChain({ jev: null, frontier });
  await assert.rejects(chain({ page: snapshot(), actions: candidates(snapshot()), observation: { epoch: 'e' } }),
    /no_advisor_decision/, 'nothing decides, so the flow stops instead of guessing');
});

test('a vision answer outside the permitted set is refused', async () => {
  const vision = visionMock({ actionId: 'a9' });
  const frontier = createFrontierVisionAdvisor({ vision });
  const chain = createAdvisorChain({ frontier });
  const page = snapshot();
  const error = await chain({ page, actions: candidates(page), observation: { epoch: 'e' } })
    .then(() => null, thrown => thrown);
  assert.equal(error.code, 'no_advisor_decision');
  assert.equal(frontier.metrics.abstained, 1);
});

test('a classified security checkpoint is L4 and never reaches vision', async () => {
  const vision = visionMock();
  const chain = createAdvisorChain({ frontier: createFrontierVisionAdvisor({ vision }),
    classifySecurityCheckpoint: classifyPage });
  const captcha = snapshot({ text: 'Verify you are human. Confirm you are not a robot.', controls: [
    { key: 'sig-a', tag: 'button', type: '', label: 'Continue', enabled: true },
    { key: 'sig-b', tag: 'button', type: '', label: 'Retry', enabled: true }] });
  assert.equal(classifyPage(captcha), 'human_verification_required');

  const error = await chain({ page: captcha, snapshot: captcha, actions: candidates(captcha),
    observation: { epoch: 'e' } }).then(() => null, thrown => thrown);
  assert.equal(error.code, 'advisor_requested_operator', 'a person is asked, the challenge is not solved');
  assert.equal(error.reason, 'human_verification_required');
  assert.deepEqual(vision.calls.capture, [], 'CAPTCHA never becomes a vision task');
  assert.equal(chain.metrics.operator, 1);
});

test('a screenshot decision from epoch N fails closed when executed against epoch N+1', async () => {
  const vision = visionMock({ actionId: 'a0' });
  const chain = createAdvisorChain({ frontier: createFrontierVisionAdvisor({ vision }) });
  const page = snapshot();
  let current = page;
  const kernel = new BrowserExecutionKernel({ account, site, workflow: 'login', runId: 'vision-run',
    observe: async () => current });
  const decidedOn = kernel.observe(page).observation;
  const decision = await chain({ page, actions: candidates(page), observation: decidedOn });
  assert.equal(decision.decisionEpoch, decidedOn.epoch);

  // The page moves on while the screenshot decision is in flight.
  const moved = { ...page, text: 'Choose how to sign in (the layout changed)', fingerprint: 'fp-later' };
  const live = kernel.observe(moved).observation;
  assert.notEqual(live.epoch, decidedOn.epoch);
  current = moved;

  const candidate = candidates(page)[0];
  let dispatched = 0;
  await assert.rejects(kernel.execute({ candidate, snapshot: moved, observation: live,
    decisionObservation: decidedOn, source: 'frontier', dispatch: async () => { dispatched++; } }),
  /stale_observation/, 'the screenshot decision is not replayed against a newer epoch');
  assert.equal(dispatched, 0);

  // Re-observing is what execution requires: the same action on the live epoch runs.
  await kernel.execute({ candidate, snapshot: moved, observation: live, decisionObservation: live,
    source: 'frontier', expectedPostcondition: null, dispatch: async () => { dispatched++; } });
  assert.equal(dispatched, 1);
});

test('an advisor proposes only: it has no way to touch the browser itself', () => {
  const jev = createJevAdvisor({ choose: jevChoose() });
  const frontier = createFrontierVisionAdvisor({ vision: visionMock() });
  for (const advisor of [jev, frontier]) {
    assert.deepEqual(Object.keys(advisor).sort(), ['advise', 'level', 'metrics', 'name']);
    assert.equal(typeof advisor.execute, 'undefined');
    assert.equal(typeof advisor.observe, 'undefined');
  }
  assert.deepEqual(Object.keys(createAdvisorChain({ jev, frontier })).sort(),
    ['advisors', 'maxVisualEscalations', 'metrics']);
});
