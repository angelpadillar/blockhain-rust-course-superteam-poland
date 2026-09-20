#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeRun } from './session.mjs';
import { saveJson } from '../../src/storage.mjs';
import { runWorkflow, validatePlan } from './workflow.mjs';

// Public task input contains observed text only. The verifier constants below
// are kept outside the compiled plan and are never sent to a chooser/runtime.
export const PUBLIC_PLAN = Object.freeze({ steps: Object.freeze([Object.freeze({ operation: 'search_and_open',
  query: 'Black hole', targetText: 'Black hole', context: 'main' })]) });
const START_URL = 'https://en.wikipedia.org/w/index.php?title=Special:Search&search=astronomy&fulltext=1';
const EXPECTED_URL = 'https://en.wikipedia.org/wiki/Black_hole';
const EXPECTED_TITLE = 'Black hole - Wikipedia';
const sourceFiles = ['public-smoke.mjs', 'workflow.mjs', 'session.mjs', 'search.mjs', '../browser-runtime-v3/browser.mjs',
  '../browser-runtime-v3/runtime.mjs', '../browser-runtime-v3/providers.mjs', '../browser-runtime-v3/planner.mjs',
  '../../src/storage.mjs', '../../src/glovo.mjs', '../../src/jev.mjs', '../../src/config.mjs', '../../src/policy.mjs', '../../src/dom.mjs',
  '../../package.json', '../../package-lock.json'];
async function fingerprint() {
  const aggregate = createHash('sha256'), files = {};
  for (const file of sourceFiles) {
    const bytes = await readFile(new URL(file, import.meta.url));
    files[file] = createHash('sha256').update(bytes).digest('hex');
    aggregate.update(file).update(bytes);
  }
  return { sha256: aggregate.digest('hex'), files };
}
const failure = code => Object.assign(new Error(code), { code });
export function parseSmokeArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let output, keyStdin = false;
  for (const arg of args) {
    if (arg === '--key-stdin' && !keyStdin) keyStdin = true;
    else if (arg.startsWith('--output=') && output === undefined) output = arg.slice('--output='.length);
    else throw failure('unsupported_or_duplicate_argument');
  }
  if (!output?.trim() || /[\x00-\x1f]/.test(output)) throw failure('explicit_output_required');
  return { output: resolve(output), keyStdin };
}

export async function runSmoke(options, { execute = executeRun, save = saveJson } = {}) {
  const before = await fingerprint();
  const stamp = row => ({ ...row, version: 4, guide: options.keyStdin ? 'jev' : 'none', receiptType: 'public_site_smoke', attempt: 1, plannedAttempts: 1,
    smokeSourceSha256: before.sha256, smokeSourceHashes: before.files,
    planning: 'Precompiled public text plan; no planner call and no OpenRouter credentials.',
    guidance: options.keyStdin ? 'Real Jev only when observed choices are ambiguous.' : 'No chooser and no model API calls; ambiguity stops.',
    methodology: 'One attempt from Wikipedia Special:Search results already seeded with astronomy/fulltext=1. This is not a homepage-start or general web benchmark. Failures are retained and never automatically retried.',
    independentVerification: 'After workflow completion only: exact public article URL and document title, plus the workflow own visible-heading evidence. Expected answers never enter the plan or chooser input.' });
  const compiledPlan = validatePlan(structuredClone(PUBLIC_PLAN));
  const report = await execute({ url: START_URL,
    goal: 'From the main search results, find Black hole and open its article.',
    item: 'unused-no-openrouter-access', guide: options.keyStdin ? 'jev' : 'openrouter-dom', keyStdin: options.keyStdin,
    output: options.output, expectedUrl: EXPECTED_URL, expectedTitle: EXPECTED_TITLE }, {
    // These bypass credential access and model construction, not browser policy.
    readOpenRouterItem: async () => null,
    createOpenRouter: () => async () => { throw failure('model_planning_disabled'); },
    createOpenRouterChooser: () => undefined,
    planGoal: async () => structuredClone(compiledPlan),
    runSearchAndOpen: async ({ task, ...rest }) => {
      const result = await runWorkflow({ ...rest, plan: task });
      return { ...result, workflowStatus: result.status, status: result.status === 'completed' ? 'opened' : 'incomplete' };
    },
    saveJson: (path, row) => save(path, stamp(row)),
  });
  report.smokeSourceUnchanged = before.sha256 === (await fingerprint()).sha256;
  if (!report.smokeSourceUnchanged) { report.status = 'incomplete'; report.reason = 'source_changed'; report.verifiedSuccess = false; }
  if (!options.keyStdin && report.accounting.modelCalls !== 0) {
    report.status = 'incomplete'; report.reason = 'unexpected_model_call'; report.verifiedSuccess = false;
  }
  await save(options.output, stamp(report));
  return stamp(report);
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseSmokeArgs(args);
    if (options.help) {
      console.log(`Single public Wikipedia smoke attempt; no automatic retries.
node experimental/browser-runtime-v4/public-smoke.mjs --output=/private/new-receipt.json

Default: no model/API calls; only unique observed choices execute.
Optional --key-stdin uses real Jev for ambiguity (hidden TTY input or a pipe).
No OpenRouter item/key is read. Output must be a new path.
Starts from existing Special:Search results, not the homepage.
Blocked site requests/challenges or ambiguous choices remain failed attempts.`);
      return 0;
    }
    const report = await runSmoke(options);
    console.log(JSON.stringify({ status: report.status, reason: report.reason, verifiedSuccess: report.verifiedSuccess,
      totalMs: report.totalMs, initialNavigationMs: report.initialNavigationMs, browserLaunchMs: report.browserLaunchMs,
      operations: report.runtime?.steps?.length || 0, modelCalls: report.accounting.modelCalls, costUsd: report.accounting.costUsd,
      sourceUnchanged: report.sourceUnchanged && report.smokeSourceUnchanged }));
    return report.verifiedSuccess && report.sourceUnchanged && report.smokeSourceUnchanged && !report.cleanupError ? 0 : 1;
  } catch (error) {
    const known = new Set(['unsupported_or_duplicate_argument', 'explicit_output_required', 'output_already_exists', 'output_create_failed', 'journal_write_failed']);
    console.error(JSON.stringify({ status: 'incomplete', reason: known.has(error.code) ? error.code : 'public_smoke_failed' }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
