#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { executeRun, parseArgs } from './session.mjs';
import { saveJson } from '../../src/storage.mjs';
import { compileWorkflow } from './planner.mjs';
import { runWorkflow } from './workflow.mjs';

const files = ['run.mjs', 'planner.mjs', 'workflow.mjs', 'search.mjs', 'session.mjs'];
async function fingerprint() {
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update(await readFile(new URL(file, import.meta.url)));
  return hash.digest('hex');
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log(`Experimental continuous read-only workflow (1–4 operations).
node experimental/browser-runtime-v4/run.mjs --url=https://example.org \\
  --goal='Search for Cedar Stationery, then find Maple Notebook and open its details.' \\
  --openrouter-item=REFERENCE --output=/private/new-result.json

Uses one inexpensive OpenRouter planning call. Guides: --guide=openrouter-dom
(default), openrouter-dom-image, or jev with --key-stdin (input hidden).
Optional external checks: --expected-url=URL --expected-title=DOCUMENT_TITLE.
Only search-and-open and already-visible named-link opening are supported.
Without independent checks, completed operation evidence remains unverified.
See README.md for supported scope and measured limitations.`);
      return 0;
    }
    const before = await fingerprint();
    const stamp = row => ({ ...row, version: 4, workflowSourceSha256: before, workflowSourceFiles: files,
      scope: 'Up to four continuous read-only search_and_open or open_link operations, with fresh references and per-operation heading evidence; final task verification is external.' });
    const report = await executeRun(options, {
      planGoal: compileWorkflow,
      runSearchAndOpen: async ({ task, ...rest }) => {
        const result = await runWorkflow({ ...rest, plan: task });
        return { ...result, workflowStatus: result.status, status: result.status === 'completed' ? 'opened' : 'incomplete' };
      },
      saveJson: (path, row) => saveJson(path, stamp(row)),
    });
    try { report.workflowSourceUnchanged = before === await fingerprint(); }
    catch { report.workflowSourceUnchanged = false; }
    if (!report.workflowSourceUnchanged) { report.status = 'incomplete'; report.reason = 'source_changed'; report.verifiedSuccess = false; }
    await saveJson(options.output, stamp(report));
    console.log(JSON.stringify({ status: report.status, reason: report.reason, verifiedSuccess: report.verifiedSuccess,
      totalMs: report.totalMs, browserLaunchMs: report.browserLaunchMs, operations: report.runtime?.steps.length,
      modelCalls: report.accounting.modelCalls, costUsd: report.accounting.costUsd, costComplete: report.accounting.costComplete }));
    return ['verified', 'opened_unverified'].includes(report.status) && report.sourceUnchanged && report.workflowSourceUnchanged && !report.cleanupError ? 0 : 1;
  } catch (error) {
    const reason = /^[a-z][a-z0-9_]{0,80}$/.test(error.code || '') ? error.code : 'workflow_cli_failed';
    console.error(JSON.stringify({ status: 'incomplete', reason })); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
