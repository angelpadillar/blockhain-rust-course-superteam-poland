import http from 'node:http';
import {readFile,writeFile,rename,open} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {McpClient,structured,pngBytes} from './vendor/mcp.mjs';
import {startDisplay} from './vendor/display.mjs';
import {acquireOwner} from './vendor/lock.mjs';
import {validateRequest,classifySnapshot,blocked,WorkerError,INITIAL_URL,SESSION_ID,reviewedBrowserHosts} from './policy.mjs';
import {inspectRegistration,inspectRegistrationState} from './registration.mjs';
import {startRegistration,startFollowupRegistration,startImportedRegistration,resumeRegistration,publicPhoneContract,followupPhoneReadiness} from './registration-actions.mjs';
import {networkHostSummary} from './network-diagnostics.mjs';

process.umask(0o077);
const ROOT='/app/state';
const token=(await readFile('/run/secrets/delio-service-token','utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(token))throw new Error('Private worker token is invalid');
const config=JSON.parse(await readFile('/app/config/worker.json','utf8'));
const browserHosts=reviewedBrowserHosts(config);
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
  client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',ROOT,'--allowed-hosts',browserHosts.join(','),'--max-sessions','1','--session-ttl','10m'],{timeoutMs:20000});
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
    let observed;
    if(request.operation==='inspectRegistrationState'){
      // Do not reopen/navigate an expired view; the caller needs the exact page
      // left by its prior action, not a reconstructed sign-in entry.
      if(!client||client.closed)throw new WorkerError('registration_current_view_unavailable');
    }else observed=await observe(check,()=>Math.floor(deadline-performance.now()));
    check();
    if(['inspectRegistration','inspectRegistrationState','startRegistration','startFollowupRegistration','resumeRegistration','startImportedRegistration'].includes(request.operation)){
      let phoneControls=null,followupReadiness={followupSubmissionReady:false,registrationIntentAccountId:null};
      const capturePrivate=async view=>{
        check();
        phoneControls=publicPhoneContract(view.html);
        let intent=null;
        try{intent=JSON.parse(await readFile(`${ROOT}/registration-intent.json`,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
        followupReadiness=followupPhoneReadiness({...view,intent,bindingSecret:token});
        const observation=JSON.stringify(view);
        const screenshot=pngBytes(await client.call('browser_screenshot',{session_id:SESSION_ID,full_page:false,max_bytes:2097152},{timeoutMs:Math.max(1,Math.min(5000,deadline-performance.now()))}));check();
        const observationSha256=createHash('sha256').update(observation).digest('hex'),screenshotSha256=createHash('sha256').update(screenshot).digest('hex');
        const artifactId=`registration-${Date.now()}-${observationSha256.slice(0,12)}`;
        for(const [name,data] of [[`${artifactId}.json`,observation],[`${artifactId}.png`,screenshot]]){
          const file=await open(`${ROOT}/${name}`,'wx',0o600);
          try{await file.writeFile(data);await file.sync();}finally{await file.close();}
        }
        const directory=await open(ROOT,'r');try{await directory.sync();}finally{await directory.close();}
        await writeFile(`${ROOT}/private-registration-current.html`,view.html,{mode:0o600});
        return [{id:artifactId,observationSha256,screenshotSha256,private:true}];
      };
      const context={client,check,remaining:()=>Math.floor(deadline-performance.now()),capturePrivate};
      const inspected=['startRegistration','startFollowupRegistration','resumeRegistration','startImportedRegistration'].includes(request.operation)
        ?await ({startRegistration,startFollowupRegistration,resumeRegistration,startImportedRegistration}[request.operation])({...context,accountId:request.accountId,phone:request.phone,
          previousPhone:request.previousPhone,previousActivationStatus:request.previousActivationStatus,approvalId:request.approvalId,activationOrderId:request.activationOrderId,root:ROOT,bindingSecret:token})
        :request.operation==='inspectRegistrationState'?await inspectRegistrationState(context):await inspectRegistration(context);
      check();
      let networkDiagnostics={available:false,hosts:[]};
      if(deadline-performance.now()>1200){
        try{networkDiagnostics=networkHostSummary(structured(await client.call('browser_network_requests',{session_id:SESSION_ID,max_events:200,clear:false},{timeoutMs:1000})));}catch{}
      }
      check();
      const observedAt=Date.now();
      const id=createHash('sha256').update(JSON.stringify({observedAt,...inspected})).digest('hex');
      const result={...inspected,...(request.operation==='inspectRegistration'?{phoneControls,phoneSubmissionReady:phoneControls?.ready===true,...followupReadiness}:{}),networkDiagnostics,observedAt,evidenceRefs:[{id,observedAt}],browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,usage:{modelCalls:0,modelCostUsd:0}};
      await writeFile(`${ROOT}/registration-inspection.json.tmp`,JSON.stringify(result,null,2),{mode:0o600});check();
      await rename(`${ROOT}/registration-inspection.json.tmp`,`${ROOT}/registration-inspection.json`);
      return inspected.status==='needs_reconciliation'
        ?{ok:false,code:'registration_reconciliation_required',result}
        :{ok:true,result};
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
    // An ordinary read failure must not discard the OTP page. A hard deadline
    // still closes the runtime to terminate potentially outstanding work.
    if(request.operation!=='inspectRegistrationState'||error?.code==='worker_deadline')await closeBrowser();
    await task.catch(()=>{});
    if(['inspectRegistration','inspectRegistrationState'].includes(request.operation)){
      const code=error instanceof WorkerError?error.code:'registration_inspection_failed';
      return {...blocked(code,'Registration inspection stopped. No customer details were entered and no SMS or cart operation was requested.'),
        result:{status:'registration_inspection_stopped',observedAt:Date.now(),browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,usage:{modelCalls:0,modelCostUsd:0},
          nativeFailure:error.browserFailure||null}};
    }
    if(['startRegistration','startFollowupRegistration','resumeRegistration','startImportedRegistration'].includes(request.operation)){
      return {ok:false,code:error instanceof WorkerError?error.code:'registration_outcome_unverified',
        result:{status:'needs_reconciliation',needsReconciliation:true,accountCreated:false,observedAt:Date.now(),
          browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,usage:{modelCalls:0,modelCostUsd:0}}};
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
