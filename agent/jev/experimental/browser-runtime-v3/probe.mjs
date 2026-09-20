import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readOpenRouterItem } from './credentials.mjs';
import { createLedger, createOpenRouter } from './providers.mjs';
import { planGoal } from './planner.mjs';

const item = process.argv.find(a => a.startsWith('--openrouter-item='))?.slice('--openrouter-item='.length);
const output = process.argv.find(a => a.startsWith('--output='))?.slice('--output='.length);
if (!item || !output) throw new Error('Use --openrouter-item=REFERENCE --output=PATH');
const ledger = createLedger({ maxCalls: 1, maxUsd: 0.01 });
const result = { purpose: 'Provider integration probe on a public synthetic goal; no browser task.', success: false };
try {
  const complete = createOpenRouter({ apiKey: await readOpenRouterItem(item), ledger });
  const task = await planGoal({ goal: 'Find the Aurora Lamp in the home office collection and open its details.', complete });
  result.success = task.targetText.toLowerCase().includes('aurora') && task.query.toLowerCase().includes('aurora') && Boolean(task.context);
  result.task = task;
} catch (error) { result.reason = error.code || 'probe_failed'; }
result.accounting = ledger.summary();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
if (!result.success) process.exitCode = 1;
