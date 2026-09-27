import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReports } from './cli.mjs';
import { summarize, failures, regression } from './metrics.mjs';
const [beforePath,afterPath]=process.argv.slice(2);if(!beforePath||!afterPath)throw new Error('usage: node compare.mjs BEFORE_RUN_DIR AFTER_RUN_DIR');
const read=async path=>JSON.parse(await readFile(join(resolve(path),'run.json'),'utf8'));
const before=await read(beforePath),after=await read(afterPath);
const output=join(dirname(fileURLToPath(import.meta.url)),'results',`comparison-${after.runId}`);await mkdir(output,{recursive:true,mode:0o700});
await writeReports(output,[before,after]);
const summaries=[before,after].flatMap(b=>['dev','heldout'].flatMap(split=>['local','stress'].map(layer=>({runId:b.runId,mode:b.config.mode,driver:b.config.driver,split,layer,...summarize(b.rows.filter(r=>r.split===split&&r.layer===layer))}))));
const result={before:before.runId,after:after.runId,gate:regression(before,after),summaries,
  devFailures:failures(after.rows.filter(r=>r.split==='dev')),
  devCases:[...new Set(after.rows.filter(r=>r.split==='dev').map(r=>r.taskId))].map(taskId=>({taskId,
    before:summarize(before.rows.filter(r=>r.taskId===taskId)),after:summarize(after.rows.filter(r=>r.taskId===taskId))})),
  heldoutIndividualTraces:'Not included in this analysis view; no task-specific tuning.'};
await writeFile(join(output,'comparison.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({output,gate:result.gate,summaries:result.summaries},null,2));
