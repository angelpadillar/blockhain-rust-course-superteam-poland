import { readFile, writeFile, mkdir, readdir, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openProvider } from './transport.mjs';
import { LOCAL_CASES, PROFILE, STRESS_SHA, stressCases, PENDING_COVERAGE } from './suite.mjs';
import { serveFixtures, attachStressOracle } from './fixtures.mjs';
import { scriptedFormDecider } from './driver.mjs';
import { classify, aggregate, regression } from './metrics.mjs';
import { createJevDecider } from '../experimental/browser-runtime-v5/jev.mjs';
import { createLedger } from '../experimental/browser-runtime-v3/providers.mjs';

const here=dirname(fileURLToPath(import.meta.url));
try{process.loadEnvFile(join(here,'../../.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const save=async(file,value)=>writeFile(file,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
const runtimeFiles=['runtime.mjs','session.mjs','snapshot.mjs','questions.mjs','policy.mjs','donewhen.mjs'];
const harnessFiles=['cli.mjs','suite.mjs','fixtures.mjs','driver.mjs','metrics.mjs','transport.mjs'];
export async function freeze() {
  const dest=join(here,'frozen-v5');await mkdir(dest,{recursive:true});
  let manifest;
  try{manifest=await json(join(dest,'manifest.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!manifest){
    const files={};
    for(const name of runtimeFiles){const bytes=await readFile(join(here,'../experimental/browser-runtime-v5',name));files[name]=hash(bytes);await writeFile(join(dest,name),bytes,{flag:'wx'});}
    manifest={version:'v5-frozen',git_sha:git(here,'rev-parse','HEAD'),files};await save(join(dest,'manifest.json'),manifest);
  }
  for(const [name,digest] of Object.entries(manifest.files))if(hash(await readFile(join(dest,name)))!==digest)throw new Error('frozen_baseline_modified');
  return manifest;
}
export function parseArgs(args) {
  const options={mode:'baseline',driver:'jev',suite:'all',split:'dev',repeat:5,maxMs:15000,maxSteps:25,
    stressRoot:process.env.BROWSER_STRESS_ROOT||'/tmp/jev-bench-stress-tests',output:join(here,'results')};
  const strings={'--mode':'mode','--driver':'driver','--suite':'suite','--split':'split','--only':'only','--stress-root':'stressRoot','--output':'output','--compare':'compare'};
  const nums={'--repeat':'repeat','--max-ms':'maxMs','--max-steps':'maxSteps'};
  for(let i=0;i<args.length;i++){
    const arg=args[i];if(['--report','--list','--freeze','--no-batch'].includes(arg)){options[arg.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=true;continue;}
    const parts=arg.split('='),name=parts[0],value=parts.length>1?parts.slice(1).join('='):args[++i];
    if(!value)throw new Error(`missing_argument:${name}`);
    if(strings[name])options[strings[name]]=value;else if(nums[name])options[nums[name]]=Number(value);else throw new Error(`unknown_argument:${name}`);
  }
  if(!['baseline','frames','hybrid','macro','main'].includes(options.mode)||!['jev','scripted'].includes(options.driver)
    ||!['all','local','stress'].includes(options.suite)||!['dev','heldout','all'].includes(options.split))throw new Error('invalid_configuration');
  for(const [key,min,max] of [['repeat',1,20],['maxMs',1000,300000],['maxSteps',1,60]])if(!Number.isInteger(options[key])||options[key]<min||options[key]>max)throw new Error(`invalid_${key}`);
  return options;
}
async function digestHarness(){const hashes={};for(const file of harnessFiles)hashes[file]=hash(await readFile(join(here,file)));return {hashes,sha:hash(JSON.stringify(hashes))};}
async function audit(page,runtime,diagnostics) {
  const data={frameControls:0,shadowControls:0,requiredFiles:0,invalidFields:0,observedControls:Math.max(0,...(runtime?.steps||[]).map(s=>s.controls||0)),...diagnostics};
  for(const frame of page.frames()){
    const value=await frame.evaluate(()=>{
      let controls=0,shadowControls=0,requiredFiles=0,invalidFields=0;const roots=[{root:document,shadow:false}];
      while(roots.length){const {root,shadow}=roots.pop();for(const el of root.querySelectorAll('*')){
        if(el.shadowRoot)roots.push({root:el.shadowRoot,shadow:true});
        if(el.matches('input,button,select,textarea,[contenteditable="true"]')&&el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})){
          controls++;if(shadow)shadowControls++;if(el.matches('input[type="file"][required]'))requiredFiles++;
          if(el.matches(':invalid'))invalidFields++;
        }
      }}return {controls,shadowControls,requiredFiles,invalidFields};
    }).catch(()=>({controls:0,shadowControls:0,requiredFiles:0,invalidFields:0}));
    if(frame!==page.mainFrame())data.frameControls+=value.controls;
    for(const key of ['shadowControls','requiredFiles','invalidFields'])data[key]+=value[key];
  }
  return data;
}
async function runOne(task,repeat,batch,directory,provider,server,runLoop,options) {
  const row={taskId:task.id,repeat,split:task.split,layer:task.layer,capability:task.capability,attempted:false,validTask:true,
    fixtureHealth:task.fixtureHealth||null,
    taskRestarts:0,recoveryAttempted:false,metrics:{},verification:null,elapsedMs:null,verifiedMs:null,totalCostUsd:null,inferenceCostUsd:null};
  batch.rows.push(row);
  let reason=null;
  if(!runLoop)reason='mode_not_implemented';
  else if(options.driver==='jev'&&!process.env.TYPESAFE_API_KEY)reason='missing_typesafe_key';
  else if(!task.oracle)reason='oracle_not_reviewed';
  if(reason){Object.assign(row,classify(reason),{reason});return row;}
  const session=await provider.open({origin:server.origin,additionalOrigins:server.additionalOrigins});
  const page=session.page,controller=new AbortController();
  const journalPath=join(directory,`${batch.rows.length}.events.jsonl`);let previous='0'.repeat(64);
  const record=async event=>{const entry={previous,event};entry.hash=hash(JSON.stringify(entry));previous=entry.hash;await appendFile(journalPath,JSON.stringify(entry)+'\n',{mode:0o600});};
  const ledger=createLedger({maxCalls:40,maxUsd:.05,onEvent:record});
  const local=task.layer==='local'?server.start(task):null;
  const oracle=local?{verify:async()=>server.verify(local.id),dispose(){}}:attachStressOracle(page,task);
  const started=performance.now();let runtime,oracleMs=0,decisionBytes=0,decisionCalls=0;
  row.attempted=true;
  try {
    const url=local?.url||`${server.origin}${task.path}`;
    await page.goto(url,{waitUntil:'load',timeout:10000});
    const initial=await oracle.verify();
    if(initial.passed){row.validTask=false;reason='initial_oracle_true';}
    else {
      const baseDecide=options.driver==='scripted'?scriptedFormDecider():createJevDecider({apiKey:process.env.TYPESAFE_API_KEY,model:process.env.JEV_MODEL||'jev-latest',ledger});
      const decide=async(request,signal)=>{decisionCalls++;decisionBytes+=Buffer.byteLength(JSON.stringify(request));const answers=await baseDecide(request,signal);await record({type:'decision',answer:answers});return answers;};
      const origins=new Set([server.origin,...server.additionalOrigins]);
      runtime=await runLoop({page,decide,signal:controller.signal,maxMs:options.maxMs,maxSteps:options.maxSteps,maxActions:50,maxModelCalls:40,
        allowedFrameUrl:url=>{try{return origins.has(new URL(url).origin);}catch{return false;}},
        spec:{goal:task.goal,values:task.values||PROFILE,files:{upload_file:join(here,'files','benchmark-upload.txt')},
          ...(options.noBatch?{batchForms:false}:{}),
          policy:{allowDestructive:true,deny:['delete','publish','transfer','buy now','pay now'],denyPath:'',avoid:['delete|publish|transfer|buy now|pay now']}},
        requestFilter:request=>{
          try{const url=new URL(request.url());if(origins.has(url.origin))return 'allow';
            if(['GET','HEAD'].includes(request.method())&&!request.isNavigationRequest()&&['script','stylesheet','image','font','media','manifest','texttrack'].includes(request.resourceType()))return 'allow';}catch{}
          return 'fatal';
        },onEvent:async event=>{
          await record(event);
          if(event.type==='step_completed'){
            const before=performance.now(),v=await oracle.verify(400);oracleMs+=performance.now()-before;
            if(v.passed){row.verifiedMs=performance.now()-started;controller.abort('oracle_verified');}
          }
        }});
      reason=runtime.reason;
    }
  } catch(error){reason=error.code||(/Timeout/.test(error.name)?'navigation_error':'harness_error');row.errorType=error.name;}
  finally {
    const before=performance.now();row.verification=await oracle.verify(2000).catch(()=>({passed:false,source:'oracle-error'}));oracleMs+=performance.now()-before;
    if(row.verification.passed&&row.verifiedMs===null)row.verifiedMs=performance.now()-started;
    row.elapsedMs=performance.now()-started;row.audit=await audit(page,runtime,session.diagnostics);
    const usage=ledger.summary(),m=runtime?.metrics||{};
    row.inferenceCostUsd=options.driver==='scripted'?0:usage.costUsd;
    row.metrics={total_actions:m.nativeActionAttempts??0,completed_native_actions:m.nativeActionsCompleted??0,
      successful_actions:null,failed_actions:null,jev_calls:options.driver==='jev'?usage.modelCalls:0,
      jev_latency_ms:options.driver==='jev'?usage.modelMs:0,jev_cost:options.driver==='jev'?usage.costUsd:0,
      small_llm_calls:0,small_llm_latency_ms:0,small_llm_cost:0,frontier_llm_calls:0,frontier_llm_latency_ms:0,frontier_llm_cost:0,
      browser_protocol_calls:null,browser_round_trips:null,instrumented_protocol_operations:m.protocolCalls??null,
      observation_ms:m.snapMs??null,decision_ms:m.pickMs??null,execution_ms:m.actMs??null,verification_ms:oracleMs,
      replans:0,retries:m.staleRefreshes??0,stale_refs:m.staleRefreshes??0,no_ops:(runtime?.steps||[]).filter(s=>/no_change|unconfirmed|no_result/.test(s.outcome||'')).length,
      repeated_actions:m.wastedSteps??0,stall_events:reason==='repeated_action_limit'?1:0,screenshots_used:0,
      DOM_bytes_serialized:null,observation_bytes:null,decision_request_bytes:decisionBytes,decision_calls:decisionCalls,
      tokens_in:options.driver==='scripted'?0:usage.usageComplete?usage.inputTokens:null,tokens_out:options.driver==='scripted'?0:usage.usageComplete?usage.outputTokens:null,
      macro_hit:false,macro_fallback:false,macro_repair:false};
    row.runtimeStatus=runtime?.status||null;row.reason=reason;row.journalHash=previous;
    row.steps=runtime?.steps||[];row.accounting=usage;
    Object.assign(row,classify(reason,row.verification,row.audit,{fileUpload:options.mode!=='baseline'}));row.metrics.final_status=row.status;
    if(!row.validTask)Object.assign(row,classify(reason));
    await record({type:'independent_verdict',status:row.status,verification:row.verification});row.journalHash=previous;
    oracle.dispose();await session.close();
  }
  return row;
}
export async function runBench(options) {
  process.umask(0o077);
  const frozen=await freeze(),harness=await digestHarness();
  const sha=git(options.stressRoot,'rev-parse','HEAD');if(sha!==STRESS_SHA)throw new Error('stress_revision_mismatch');
  if(git(options.stressRoot,'status','--porcelain'))throw new Error('stress_worktree_modified');
  const inventory=[...LOCAL_CASES,...await stressCases(options.stressRoot)];
  const tasks=inventory.filter(t=>(options.suite==='all'||t.layer===options.suite)&&(options.split==='all'||t.split===options.split)&&(!options.only||t.id===options.only||t.name===options.only));
  if(options.only&&!tasks.length)throw new Error('task_not_in_selected_split_or_suite');
  if(options.list){console.log(JSON.stringify({stress_sha:sha,tasks:inventory,pendingCoverage:PENDING_COVERAGE},null,2));return;}
  const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
  const directory=join(resolve(options.output),runId);await mkdir(directory,{recursive:true,mode:0o700});
  const {mode,driver,suite,split,repeat,maxMs,maxSteps,only}=options;
  const runtimeRoot=mode==='baseline'?join(here,'frozen-v5'):join(here,'../experimental/browser-runtime-v6');
  const runtimeHashes={};
  if(['baseline','frames'].includes(mode))for(const file of (await readdir(runtimeRoot)).filter(f=>f.endsWith('.mjs')&&!f.endsWith('.test.mjs')).sort())runtimeHashes[file]=hash(await readFile(join(runtimeRoot,file)));
  const batch={runId,config:{mode,driver,suite,split,repeat,maxMs,maxSteps,only:only||null,batchForms:mode==='baseline'?null:!options.noBatch},manifest:{timestamp:new Date().toISOString(),
    git_sha:git(here,'rev-parse','HEAD'),working_tree_dirty:Boolean(git(here,'status','--porcelain')),runtime_version:mode==='baseline'?'v5-frozen':mode,
    adapter_version:'bench-v2',baseline:frozen,runtime_hashes:runtimeHashes,harness_hashes:harness.hashes,suite_sha:hash(JSON.stringify(inventory)),stress_sha:sha,
    model:driver==='jev'?(process.env.JEV_MODEL||'jev-latest'):null,jev_actual_models:[],temperature:null,
    environment:{node:process.version,platform:process.platform,arch:process.arch},browser_provider:null,browser_version:null},
    methodology:{driver:driver==='scripted'?'Fixed generic form policy. Kernel compatibility only; NOT Jev/agent accuracy.':'Real Jev through unchanged v5 decision integration.',
      success:'Independent server submission record or post-action rendered/dialog/console success signal. Agent DONE is not sufficient.',
      denominator:'All attempted valid tasks, including policy stops, unsupported capabilities and infrastructure failures. Preflight missing credentials/modes are not attempted and listed separately.',
      latency:'Navigation start through independent verification. p95 suppressed below 20 successes; terminal latency includes unsuccessful attempts.',
      cost:'Inference is separately metered/estimated by existing ledger. Local browser/runtime cost is unpriced: total cost/success remains null.',
      calls:'v5 protocolCalls counts instrumented wrapper operations, NOT true CDP calls or wire round trips. Uninstrumented fields are null.',
      split:'Pinned name-hash split v1. Previously inspected pages are DEV. No per-heldout failure inspection or tuning.',
      safety:'Isolated fresh profiles, fictitious data, loopback-only mutations; remote requests limited to passive GET/HEAD assets. No production payment/session access.'},
    plannedRuns:tasks.length*repeat,inventory:inventory.map(({values,goal,...t})=>t),pendingCoverage:PENDING_COVERAGE,rows:[],status:'running'};
  await save(join(directory,'run.json'),batch);
  let provider,server,runLoop;
  try {
    if(mode==='baseline')({runLoop}=await import('./frozen-v5/runtime.mjs'));
    else if(mode==='frames')({runLoop}=await import('../experimental/browser-runtime-v6/runtime.mjs'));
    if(runLoop&&(driver==='scripted'||process.env.TYPESAFE_API_KEY)){provider=await openProvider();server=await serveFixtures(options.stressRoot);
      batch.manifest.browser_provider=provider.name;batch.manifest.browser_version=provider.version;batch.manifest.browser_startup_ms=provider.startupMs;}
    for(let r=1;r<=repeat;r++)for(const task of tasks){
      const row=await runOne(task,r,batch,directory,provider,server,runLoop,options);
      await save(join(directory,'run.json'),batch);
      console.log(JSON.stringify({runId,task:row.taskId,repeat:r,status:row.status,cause:row.cause,elapsedMs:row.elapsedMs}));
    }
    batch.status='finished';
  } catch(error){batch.status='interrupted';batch.error=error.code||error.message;throw error;}
  finally{
    if(provider)await provider.close();if(server)await server.close();
    batch.manifest.jev_actual_models=[...new Set(batch.rows.flatMap(r=>(r.accounting?.calls||[]).map(c=>c.actualModel).filter(Boolean)))];
    const runtimeUnchanged=(await Promise.all(Object.entries(runtimeHashes).map(async([file,digest])=>hash(await readFile(join(runtimeRoot,file)))===digest))).every(Boolean);
    batch.sourceUnchanged=runtimeUnchanged&&(await digestHarness()).sha===harness.sha&&git(options.stressRoot,'status','--porcelain')==='';
    batch.summary=aggregate([batch]);await save(join(directory,'run.json'),batch);await writeReports(directory,[batch]);
    console.log(`RESULT ${join(directory,'run.json')}`);
  }
  return {batch,directory};
}
const display=(n,digits=1)=>n===null||n===undefined?'n/a':Number(n).toFixed(digits);
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function writeReports(directory,batches) {
  const summaries=aggregate(batches),lines=['# Browser execution benchmark','','Scripted rows measure kernel compatibility, not autonomous agent success. Missing instrumentation is n/a, never zero.','',
    '| Architecture / driver / split / layer | Tasks | Attempted / planned | Verified | Pass@1 | P50 verified ms | P95 verified ms | Cost/success | Jev/task | Frontier/task | Wire round trips/task |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for(const s of summaries)lines.push(`| ${s.key} | ${s.tasks} | ${s.attempted}/${s.plannedRuns} | ${s.passed}/${s.attempted} (${s.verifiedSuccess===null?'n/a':display(100*s.verifiedSuccess)+'%'}) | ${s.passAt1===null?'n/a':display(100*s.passAt1)+'%'} | ${display(s.timeToVerifiedMs.p50)} | ${display(s.timeToVerifiedMs.p95)} | ${display(s.costPerSuccessUsd,6)} | ${display(s.jevCalls.mean)} | ${display(s.escalations.mean)} | ${display(s.browserRoundTrips.mean)} |`);
  for(const s of summaries){lines.push('',`## ${s.key}`,'',`Status counts: ${JSON.stringify(s.statusCounts)}`,
    `Wilson 95% interval (descriptive, repeated tasks correlated): ${s.ci95?s.ci95.map(x=>display(100*x)+'%').join(' to '):'n/a'}`,'',
    '| Capability | Verified / attempted | Status counts |','|---|---:|---|');
    for(const c of s.capabilities)lines.push(`| ${c.capability} | ${c.passed}/${c.attempted} | ${JSON.stringify(c.statusCounts)} |`);
    lines.push('','### Failures by lost verified outcomes','', '| Cause | Count | Lost success points | Wasted ms |','|---|---:|---:|---:|');
    for(const f of s.failures.byLostSuccess.slice(0,10))lines.push(`| ${f.cause} | ${f.count} | ${display(f.lostSuccessPercentagePoints)} | ${display(f.wastedMs)} |`);
  }
  lines.push('','## Pending coverage','',...PENDING_COVERAGE.map(x=>`- ${x}`),'','## Runs','',...batches.map(b=>`- ${b.runId}; ${b.status}; source unchanged: ${b.sourceUnchanged}`));
  await save(join(directory,'summary.json'),summaries);
  await writeFile(join(directory,'report.md'),lines.join('\n')+'\n',{mode:0o600});
  await writeFile(join(directory,'report.html'),`<!doctype html><meta charset="utf-8"><title>Browser verified outcomes</title><style>body{font:14px ui-monospace,monospace;max-width:1600px;margin:32px auto;padding:20px;color:#17212b;background:#f5f7f9}pre{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;background:white;padding:24px;border:1px solid #ccd4dc}</style><h1>Verified browser outcomes</h1><pre>${escape(lines.join('\n'))}</pre>`,{mode:0o600});
}
export async function main(args=process.argv.slice(2)) {
  const options=parseArgs(args);
  if(options.freeze){console.log(JSON.stringify(await freeze(),null,2));return;}
  if(options.report){
    const entries=await readdir(options.output,{withFileTypes:true});const batches=[];
    for(const entry of entries.filter(e=>e.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){try{batches.push(await json(join(options.output,entry.name,'run.json')));}catch(e){if(e.code!=='ENOENT')throw e;}}
    await writeReports(options.output,batches);console.log(join(options.output,'report.html'));return;
  }
  const result=await runBench(options);
  if(options.compare&&result){const gate=regression(await json(options.compare),result.batch);await save(join(result.directory,'regression.json'),gate);console.log(JSON.stringify(gate));if(gate.gate!=='NO_OBSERVED_REGRESSION')process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
