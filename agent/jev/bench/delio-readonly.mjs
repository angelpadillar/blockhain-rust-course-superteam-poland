import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const adapterPath=process.env.DELIO_ADAPTER_PATH;
if(!adapterPath)throw new Error('Set DELIO_ADAPTER_PATH to the existing authorized Delio adapter.mjs; no session credentials are read by this script.');
const {remoteWorker}=await import(pathToFileURL(adapterPath).href);
const runId=`delio-readonly-${randomUUID()}`,rows=[];
for(let repeat=1;repeat<=3;repeat++){
  const started=performance.now();let row={repeat,status:'BLOCKED',cause:null};
  try{
    const reply=await remoteWorker({operation:'observeCart'},{signal:AbortSignal.timeout(65000)});
    const r=reply.result;
    const valid=reply.ok===true&&r?.verified===true&&Array.isArray(r.lines)
      &&r.lines.every(l=>typeof l.productId==='string'&&Number.isSafeInteger(l.quantity)&&l.quantity>0)
      &&new Set(r.lines.map(l=>l.productId)).size===r.lines.length
      &&r.lines.reduce((sum,l)=>sum+l.quantity,0)===r.declaredCount
      &&Number.isFinite(r.observedAt)&&r.observedAt<=Date.now()&&Date.now()-r.observedAt<65000
      &&Array.isArray(r.evidenceRefs)&&r.evidenceRefs.length>0;
    row={...row,status:valid?'PASS':'BLOCKED',cause:valid?null:String(reply.code||'VERIFIER_FAILED'),
      lineCount:r?.lines?.length??null,declaredCount:r?.declaredCount??null,evidenceCount:r?.evidenceRefs?.length??0,
      observationHash:valid?createHash('sha256').update(JSON.stringify(r.lines.map(({productId,quantity})=>({productId,quantity})).sort((a,b)=>a.productId.localeCompare(b.productId)))).digest('hex'):null};
  }catch(error){row.cause=error.code||'TRANSPORT_UNAVAILABLE';}
  row.elapsedMs=performance.now()-started;rows.push(row);console.log(JSON.stringify(row));
  if(row.status!=='PASS')break;
}
const output=join(here,'results',runId);await mkdir(output,{recursive:true,mode:0o700});
const report={runId,scope:'Existing Delio worker read-only cart observation. Separate MCP kernel/provider; NOT part of local Playwright comparison.',
  oracle:'Existing merchant line parser plus independent response-shape, quantity parity, evidence and freshness validation. No oracle of merchant backend order state.',
  mutations:0,purchases:0,rows,requestedRuns:3,completedRuns:rows.length};
await writeFile(join(output,'delio.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(`RESULT ${join(output,'delio.json')}`);
