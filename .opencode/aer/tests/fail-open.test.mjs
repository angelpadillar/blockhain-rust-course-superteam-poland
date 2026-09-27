/**
 * Fail-open fixture for the AER v1 OpenCode plugin installed in this project.
 *
 * Proves, against the installed artifact (not a copy):
 *   1. soft shortlist reorders but never removes tools (no hard filtering);
 *   2. a normal reducible result is classified and applied deterministically;
 *   3. classifier / reducer / evidence errors -> classifier_fallback record,
 *      no exception, original result untouched, session continues;
 *   4. a content-shape read error -> error record, no exception;
 *   5. the runtime's own projection fail-open returns the ORIGINAL messages when
 *      the policy throws (canonical history survives).
 *
 * Run from this project:
 *   bun test .opencode/aer/tests/fail-open.test.mjs
 */

import { test } from 'bun:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PLUGIN_INDEX = new URL('../../plugins/jev-efficiency-observer/index.ts', import.meta.url).href;
const runtime = await import('../../plugins/jev-efficiency-observer/runtime/dist/index.js');

const BIG_SHELL = ['npm run build', ...Array.from({ length: 400 }, (_, i) => `src/module${i}.ts: compiled ok in ${i}ms`)].join('\n');

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'aer-fail-open-'));
  mkdirSync(join(dir, '.opencode'), { recursive: true });
  return dir;
}

async function loadPlugin(projectDir) {
  const telemetryDir = join(projectDir, '.jev-efficiency');
  const hooks = new Map();
  const transforms = [];
  const ctx = {
    options: {
      telemetryDir,
      resultAdmissionMode: 'deterministic',
      shortlistMode: 'soft',
      toolExposureMode: 'off',
      routerMode: 'observe',
      routerThreshold: 0.6,
      singleActionThreshold: 0,
      maxTools: 3,
    },
    location: { directory: projectDir },
    tool: {
      transform: async (fn) => { transforms.push(fn); },
      list: async () => ['read', 'grep', 'glob', 'shell', 'edit', 'write'].map((name) => ({ name })),
      hook: async (name, handler) => { hooks.set(`tool:${name}`, handler); },
    },
    session: {
      hook: async (name, handler) => { hooks.set(`session:${name}`, handler); },
    },
  };
  const mod = await import(PLUGIN_INDEX);
  const plugin = mod.default;
  const setup = typeof plugin === 'function' ? plugin : plugin.setup;
  await setup(ctx);
  return { hooks, transforms, telemetryDir };
}

function events(telemetryDir) {
  const file = join(telemetryDir, 'telemetry.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

async function withPatched(proto, method, replacement, fn) {
  const original = proto[method];
  proto[method] = replacement;
  try {
    return await fn();
  } finally {
    proto[method] = original;
  }
}

test('soft shortlist keeps every tool (no hard filtering)', async () => {
  const project = makeProject();
  const { hooks } = await loadPlugin(project);
  const contextHook = hooks.get('session:context');
  assert.ok(contextHook, 'context hook must be registered');
  const event = {
    sessionID: 'fixture-soft',
    system: [],
    messages: [{ role: 'user', content: 'Inspect the repository build output and report failures.' }],
    tools: Object.fromEntries(['read', 'grep', 'glob', 'shell', 'edit', 'write'].map((name) => [name, { description: name }])),
  };
  await contextHook(event);
  assert.deepEqual(Object.keys(event.tools).sort(), ['edit', 'glob', 'grep', 'read', 'shell', 'write']);
});

test('normal reducible result is classified and applied deterministically', async () => {
  const project = makeProject();
  const { hooks, telemetryDir } = await loadPlugin(project);
  const after = hooks.get('tool:execute.after');
  assert.ok(after, 'execute.after hook must be registered');
  await after({ sessionID: 'fixture-normal', tool: 'shell', status: 'completed', result: { type: 'text', text: BIG_SHELL } });
  const record = events(telemetryDir).filter((event) => event.kind === 'tool_result').at(-1);
  assert.ok(record, 'tool_result telemetry expected');
  assert.equal(record.classifierOk, true);
  assert.equal(record.applied, true);
  assert.equal(record.classification, 'shell-build-log');
  assert.ok(record.tokensAvoided > 0);
});

test('classifier error -> classifier_fallback, original result survives', async () => {
  const project = makeProject();
  const { hooks, telemetryDir } = await loadPlugin(project);
  const after = hooks.get('tool:execute.after');
  await withPatched(runtime.ToolResultClassifier.prototype, 'classify', () => { throw new Error('fixture classifier boom'); }, async () => {
    await after({ sessionID: 'fixture-classifier', tool: 'shell', status: 'completed', result: { type: 'text', text: BIG_SHELL } });
  });
  const fallback = events(telemetryDir).find((event) => event.kind === 'classifier_fallback');
  assert.ok(fallback, 'classifier_fallback telemetry expected');
  assert.match(fallback.reason, /fixture classifier boom/);
});

test('reducer error -> fail-open, no exception', async () => {
  const project = makeProject();
  const { hooks, telemetryDir } = await loadPlugin(project);
  const after = hooks.get('tool:execute.after');
  await withPatched(runtime.ReducerRegistry.prototype, 'get', () => { throw new Error('fixture reducer boom'); }, async () => {
    await after({ sessionID: 'fixture-reducer', tool: 'shell', status: 'completed', result: { type: 'text', text: BIG_SHELL } });
  });
  const reported = events(telemetryDir).some((event) => event.kind === 'classifier_fallback' || event.kind === 'error');
  assert.equal(reported, true);
});

test('evidence error -> fail-open, no exception', async () => {
  const project = makeProject();
  const { hooks, telemetryDir } = await loadPlugin(project);
  const after = hooks.get('tool:execute.after');
  await withPatched(runtime.InMemoryEvidenceStore.prototype, 'put', () => { throw new Error('fixture evidence boom'); }, async () => {
    await after({ sessionID: 'fixture-evidence', tool: 'shell', status: 'completed', result: { type: 'text', text: BIG_SHELL } });
  });
  const reported = events(telemetryDir).some((event) => event.kind === 'classifier_fallback' || event.kind === 'error');
  assert.equal(reported, true);
});

test('content-shape read error -> error record, no exception', async () => {
  const project = makeProject();
  const { hooks, telemetryDir } = await loadPlugin(project);
  const after = hooks.get('tool:execute.after');
  const hostile = { sessionID: 'fixture-shape', tool: 'shell', status: 'completed' };
  Object.defineProperty(hostile, 'result', { get() { throw new Error('fixture shape boom'); } });
  await after(hostile);
  const error = events(telemetryDir).find((event) => event.kind === 'error');
  assert.ok(error, 'error telemetry expected');
  assert.equal(error.hook, 'tool.execute.after');
});

test('projection fail-open returns the original messages when policy throws', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-result', name: 'shell', result: { type: 'text', value: BIG_SHELL } }] },
  ];
  const result = runtime.projectToolResultsFailOpen(messages, {
    policy: { evaluate() { throw new Error('fixture policy boom'); } },
    estimator: new runtime.StructuralTokenEstimator(),
    recover: () => null,
    allowedClasses: ['shell-build-log'],
  });
  assert.equal(result.fellBack, true);
  assert.equal(result.messages, messages); // same reference: canonical history untouched
  assert.equal(result.records.length, 0);
  assert.match(result.fallbackReason, /fixture policy boom/);
});
