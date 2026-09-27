import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const hash=x=>createHash('sha256').update(x).digest('hex');
const paths=process.argv.slice(2);if(!paths.length)throw new Error('usage: node check-artifacts.mjs RUN_DIRECTORY ...');
for(const directory of paths.map(path=>resolve(path))){
  const run=JSON.parse(await readFile(join(directory,'run.json'),'utf8'));const violations=[];
  if(run.status!=='finished'||run.rows.length!==run.plannedRuns)violations.push('incomplete_run');
  if(!run.sourceUnchanged)violations.push('source_changed');
  const seen=new Set();let checked=0;
  for(const [i,row] of run.rows.entries()){
    const key=`${row.taskId}:${row.repeat}`;if(seen.has(key))violations.push('duplicate_attempt_key');seen.add(key);
    if(row.status==='PASS'&&(!row.verification?.passed||row.verification.safetyViolation||row.verification.duplicateSubmission||!row.attempted||row.validTask===false))violations.push('invalid_pass');
    if(!row.journalHash)continue;
    let previous='0'.repeat(64);
    for(const line of (await readFile(join(directory,`${i+1}.events.jsonl`),'utf8')).trim().split('\n')){
      const entry=JSON.parse(line);
      if(entry.previous!==previous||entry.hash!==hash(JSON.stringify({previous:entry.previous,event:entry.event})))violations.push('journal_hash_mismatch');
      previous=entry.hash;
    }
    if(previous!==row.journalHash)violations.push('journal_tail_mismatch');checked++;
  }
  const result={runId:run.runId,rows:run.rows.length,planned:run.plannedRuns,journalsChecked:checked,valid:violations.length===0,violations:[...new Set(violations)]};
  await writeFile(join(directory,'integrity.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result));if(!result.valid)process.exitCode=1;
}
