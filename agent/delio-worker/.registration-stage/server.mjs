import http from 'node:http';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {McpClient,structured} from './vendor/mcp.mjs';
import {startDisplay} from './vendor/display.mjs';
import {acquireOwner} from './vendor/lock.mjs';
import {validateRequest,classifySnapshot,blocked,WorkerError,INITIAL_URL,SESSION_ID} from './policy.mjs';
import {inspectRegistration} from './registration.mjs';

process.umask(0o077);
const ROOT='/app/state';
const token=(await readFile('/run/secrets/delio-service-token','utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Private worker token is invalid');
const config=JSON.parse(await readFile('/app/config/worker.json','utf8'));
if(config.initialUrl!==INITIAL_URL || !Array.isArray(config.allowedHosts) || config.allowedHosts.length!==1 || config.allowedHosts[0]!=='delio.com.pl')throw new Error('Explicit reviewed merchant scope required');
const reviewedMapHosts=Array.isArray(config.reviewedMapHosts)?config.reviewedMapHosts:[];
if(reviewedMapHosts.some(host=>!['maps.googleapis.com','maps.gstatic.com'].includes(host)))throw new Error('Unreviewed map dependency');
const browserHosts=['delio.com.pl',...new Set(reviewedMapHosts)];
const release=await acquireOwner(ROOT);
let client,stopDisplay,busy=false,closing=false,idleTimer;
const capability={observeCart:false,mutateCart:false,quote:false};

async function closeBrowser(){
  clearTimeout(idleTimer);
  const current=client;client=undefined;
  if(current){try{await current.call('session_destroy',{session_id:SESSION_ID},{timeoutMs:2000});}catch{}await current.close();}
  stopDisplay?.();stopDisplay=undefined;
}
async function ensureBrowser(check){
  check();
  if(client&&!client.closed)return false;
  await closeBrowser();check();
  stopDisplay=await startDisplay({desktop:config.manualDesktop===true});check();
  client=new McpClient(['mcp','--transport','stdio','--toolset','core','--session-dir',ROOT,'--allowed-hosts',browserHosts.join(','),'--max-sessions','1','--session-ttl','10m'],{timeoutMs:20000});
  const init=await client.initialize();check();
  if(String(init.serverInfo?.version).replace(/^v/,'')!=='0.1.29')throw new WorkerError('runtime_version_mismatch');
  await client.call('session_create',{session_id:SESSION_ID,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});check();
  return true;
}
async function observe(check,remaining){
  const fresh=await ensureBrowser(check);check();
  if(fresh)await client.call('browser_navigate',{session_id:SESSION_ID,require_existing:true,url:INITIAL_URL,wait_until:'load',timeout_ms:Math.max(1000,Math.min(18000,remaining()))});
  check();
  const snapshot=structured(await client.call('browser_snapshot',{session_id:SESSION_ID,max_elements:1000,interactive_only:false},{timeoutMs:Math.max(1000,Math.min(5000,remaining()))}));
  check();
  return classifySnapshot(snapshot);
}
async function operation(request){
  const started=performance.now(),deadline=started+27000;
  const check=()=>{if(closing||performance.now()>=deadline)throw new WorkerError('worker_deadline');};
  let deadlineTimer;
  const task=(async()=>{
    const observed=await observe(check,()=>Math.floor(deadline-performance.now()));check();
    if(request.operation==='inspectRegistration'){
      const inspected=await inspectRegistration({client,check,remaining:()=>Math.floor(deadline-performance.now())});check();
      const observedAt=Date.now();
      const id=createHash('sha256').update(JSON.stringify({observedAt,...inspected})).digest('hex');
      const result={...inspected,observedAt,evidenceRefs:[{id,observedAt}],browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,usage:{modelCalls:0,modelCostUsd:0}};
      await writeFile(`${ROOT}/registration-inspection.json.tmp`,JSON.stringify(result,null,2),{mode:0o600});check();
      await rename(`${ROOT}/registration-inspection.json.tmp`,`${ROOT}/registration-inspection.json`);
      return {ok:true,result};
    }
    if(config.deliveryLookup?.status==='unresolved')observed.blockers.splice(1,0,{code:'delivery_lookup_unresolved',message:'The prior authorized address lookup produced no visible suggestions or map. Coverage is unresolved, not established as out of area.'});
    if(config.deliveryLookup?.status==='confirmation_unverified')observed.blockers.splice(1,0,{code:'delivery_confirmation_unverified',message:'The exact address candidate and postcode were observed, but native address confirmation did not complete. Manual confirmation is required; coverage and delivery slot remain unverified.'});
    const observedAt=Date.now();
    const id=createHash('sha256').update(JSON.stringify({observedAt,...observed})).digest('hex');
    const result={...observed,observedAt,evidenceRefs:[{id,observedAt}],browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,usage:{modelCalls:0,modelCostUsd:0},manualOnboarding:{available:config.manualDesktop===true,private:true,idleCloseMs:config.manualDesktop===true?300000:120000},deliveryLookup:config.deliveryLookup?{status:config.deliveryLookup.status,observedAt:config.deliveryLookup.observedAt}:null,deliveryCommitment:null};
    check();
    await writeFile(`${ROOT}/current-status.json.tmp`,JSON.stringify(result,null,2),{mode:0o600});check();
    await rename(`${ROOT}/current-status.json.tmp`,`${ROOT}/current-status.json`);
    if(request.operation==='status')return {ok:true,result};
    return {ok:false,code:observed.blockers[0].code,dispatched:false,blockers:observed.blockers,result};
  })();
  try {
    return await Promise.race([task,new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>reject(new WorkerError('worker_deadline')),27000);})]);
  }catch(error){
    await closeBrowser();
    await task.catch(()=>{});
    if(request.operation==='inspectRegistration'){
      const code=error instanceof WorkerError?error.code:'registration_inspection_failed';
      return {...blocked(code,'Registration inspection stopped. No customer details were entered and no SMS or cart operation was requested.'),
        result:{status:'registration_inspection_stopped',observedAt:Date.now(),browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,usage:{modelCalls:0,modelCostUsd:0},
          nativeFailure:error.browserFailure||null}};
    }
    throw error;
  }finally{
    clearTimeout(deadlineTimer);
    // The race attaches a rejection handler to the in-flight task; cleanup never
    // labels an uncertain merchant action retryable. Cart dispatch is absent.
    if(client&&!client.closed)idleTimer=setTimeout(()=>{void closeBrowser().catch(()=>{});},config.manualDesktop===true?300000:120000);
  }
}
function authenticated(request){
  const supplied=Buffer.from(request.headers.authorization||'');
  const expected=Buffer.from(`Bearer ${token}`);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
}
const server=http.createServer(async(req,res)=>{
  const send=(status,payload)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(payload));};
  if(req.method!=='POST'||req.url!=='/rpc')return send(404,blocked('not_found','This endpoint is not available.'));
  if(!authenticated(req))return send(401,blocked('unauthorized','Private worker admission failed.'));
  if(busy||closing)return send(409,blocked('worker_busy','The single owned browser is already in use.'));
  let raw='';
  try{
    for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw new WorkerError('invalid_request');}
    const request=validateRequest(JSON.parse(raw));
    if(busy||closing)return send(409,blocked('worker_busy','The single owned browser is already in use.'));
    busy=true;clearTimeout(idleTimer);
    try{send(200,await operation(request));}
    finally{busy=false;}
  }catch(error){
    const code=error instanceof WorkerError?error.code:'worker_observation_failed';
    send(400,blocked(code,'The worker could not verify merchant access. No cart operation was dispatched.'));
  }
});
server.requestTimeout=30000;server.headersTimeout=10000;
server.listen(8794,'127.0.0.1');
async function shutdown(){if(closing)return;closing=true;server.close();await closeBrowser();await release();}
process.once('SIGTERM',()=>shutdown().finally(()=>process.exit(0)));
process.once('SIGINT',()=>shutdown().finally(()=>process.exit(0)));
