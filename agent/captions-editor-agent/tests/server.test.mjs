import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/server.mjs';
const token='t'.repeat(40),config={profileId:'captions-test',assets:{clip:{}},styles:['Velocity']};
const task={assetId:'clip',trimStart:0,trimEnd:4,style:'Velocity',expectedCaption:'Find leads with Buena'};
async function fixture(run){
  const dataDir=await mkdtemp(join(tmpdir(),'caption-http-'));let calls=0;
  const service=await createService({config,dataDir,token,ready:async()=>true,runner:async({signal})=>{calls++;await new Promise(r=>{const timer=setTimeout(r,100);signal.addEventListener('abort',()=>{clearTimeout(timer);r();},{once:true});});return{status:signal.aborted?'cancelled':'needs_attention',reason:'fixture_only'};}});
  await new Promise(r=>service.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${service.server.address().port}`;
  try{await run({url,service,calls:()=>calls});}finally{await service.close();await rm(dataDir,{recursive:true,force:true});}
}
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition timeout');}
const headers={authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':'same_request_1'};
test('unauthenticated and cross-origin requests cannot control the browser',()=>fixture(async({url})=>{
  assert.equal((await fetch(url+'/v1/status')).status,401);
  assert.equal((await fetch(url+'/v1/status',{headers:{...headers,Origin:'https://evil.org'}})).status,403);
}));
test('concurrent duplicate submissions admit exactly one job; mismatched reuse conflicts',()=>fixture(async({url,calls})=>{
  const responses=await Promise.all(Array.from({length:8},()=>fetch(url+'/v1/jobs',{method:'POST',headers,body:JSON.stringify(task)})));
  const data=await Promise.all(responses.map(r=>r.json()));assert.equal(new Set(data.map(x=>x.id)).size,1);await until(()=>calls()===1);assert.equal(calls(),1);
  const conflict=await fetch(url+'/v1/jobs',{method:'POST',headers,body:JSON.stringify({...task,trimEnd:3})});assert.equal(conflict.status,409);
}));
test('cancellation reaches the active worker and never resubmits it',()=>fixture(async({url,service,calls})=>{
  const {job}=await service.submit(task,'cancellable_1');await until(()=>calls()===1);await fetch(`${url}/v1/jobs/${job.id}/cancel`,{method:'POST',headers});
  await until(()=>service.jobs.get(job.id).status==='cancelled');assert.equal(service.jobs.get(job.id).status,'cancelled');assert.equal(calls(),1);
}));
test('MCP surface exposes bounded jobs, never raw JavaScript, CDP or general browser actions',()=>fixture(async({url})=>{
  const result=await(await fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})})).json();
  assert.deepEqual(result.result.tools.map(x=>x.name),['editor_status','editor_submit','editor_job','editor_cancel','editor_artifacts']);
}));
