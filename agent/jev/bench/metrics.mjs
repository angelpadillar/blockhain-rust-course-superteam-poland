export const STATUSES = ['PASS','FAIL','TIMEOUT','BLOCKED','NEEDS_HUMAN','UNSUPPORTED'];
export function classify(reason, verification, audit = {}, caps = {}) {
  if (verification?.safetyViolation) return {status:'FAIL',cause:'POLICY_BLOCK',safetyViolation:true};
  if (verification?.duplicateSubmission) return {status:'FAIL',cause:'REPLAY_VIOLATION'};
  if (verification?.passed) return {status:'PASS',cause:null};
  if (reason === 'missing_typesafe_key') return {status:'BLOCKED',cause:'SECRET_REQUIRED'};
  if (reason === 'mode_not_implemented' || reason === 'oracle_not_reviewed') return {status:'UNSUPPORTED',cause:'UNSUPPORTED'};
  if (reason === 'initial_oracle_true' || reason === 'broken_fixture') return {status:'BLOCKED',cause:'INVALID_FIXTURE'};
  if (/provider_http_40[13]/.test(reason || '')) return {status:'BLOCKED',cause:'AUTH_REQUIRED'};
  if (/provider_|model_cost_budget|model_call_budget/.test(reason || '')) return {status:'BLOCKED',cause:'MODEL_PROVIDER_ERROR'};
  if (/time_limit|Timeout|timeout/.test(reason || '')) return {status:'TIMEOUT',cause:'NETWORK_TIMEOUT'};
  if (/outside_navigation_scope|forbidden_request|destructive_blocked/.test(reason || '')) return {status:'BLOCKED',cause:'POLICY_BLOCK'};
  if (reason === 'uncertain_execution') return {status:'FAIL',cause:'UNCERTAIN_RESULT'};
  if (/stale/.test(reason || '')) return {status:'FAIL',cause:'STALE_TARGET'};
  if (/popup/.test(reason || '')) return {status:'UNSUPPORTED',cause:'POPUP_ERROR'};
  if (/download/.test(reason || '')) return {status:'UNSUPPORTED',cause:'UNSUPPORTED'};
  if (audit.frameControls > 0 && audit.observedControls === 0) return {status:'FAIL',cause:'IFRAME_UNREACHABLE'};
  if (audit.shadowControls > 0 && audit.observedControls === 0) return {status:'FAIL',cause:'SHADOW_DOM_UNREACHABLE'};
  if (audit.requiredFiles > 0 && !caps.fileUpload) return {status:'UNSUPPORTED',cause:'FILE_UPLOAD_UNSUPPORTED'};
  if (audit.pageErrors > 0 && audit.observedControls === 0) return {status:'BLOCKED',cause:'PAGE_SCRIPT_ERROR'};
  if (/repeated_action|step_limit/.test(reason || '')) return {status:'FAIL',cause:'STALL'};
  if (/no_candidates|target_unresolved/.test(reason || '')) return {status:'FAIL',cause:'ELEMENT_NOT_DISCOVERED'};
  if (reason === 'invalid_model_answer') return {status:'FAIL',cause:'MODEL_WRONG_DECISION'};
  if (reason === 'navigation_error') return {status:'BLOCKED',cause:'NAVIGATION_ERROR'};
  if (audit.invalidFields > 0) return {status:'FAIL',cause:'FORM_VALIDATION'};
  return {status:'FAIL',cause:'VERIFIER_FAILED'};
}
export function quantile(values, q) {
  const v=values.filter(Number.isFinite).sort((a,b)=>a-b);if(!v.length)return null;
  const at=(v.length-1)*q,lo=Math.floor(at),hi=Math.ceil(at);return v[lo]+(v[hi]-v[lo])*(at-lo);
}
export function distribution(values) {
  const v=values.filter(Number.isFinite);
  return {n:v.length,mean:v.length?v.reduce((a,b)=>a+b,0)/v.length:null,p50:quantile(v,.5),
    p90:v.length>=10?quantile(v,.9):null,p95:v.length>=20?quantile(v,.95):null};
}
export function wilson(successes, n) {
  if(!n)return null;
  const z=1.959963984540054,p=successes/n,d=1+z*z/n;
  const center=(p+z*z/(2*n))/d,half=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;
  return [Math.max(0,center-half),Math.min(1,center+half)];
}
export function summarize(rows) {
  const attempted=rows.filter(r=>r.attempted&&r.validTask!==false),passes=attempted.filter(r=>r.status==='PASS');
  const totalCostKnown=attempted.length>0&&attempted.every(r=>Number.isFinite(r.totalCostUsd));
  const recovery=attempted.filter(r=>r.recoveryAttempted);
  const statusCounts=Object.fromEntries(STATUSES.map(s=>[s,rows.filter(r=>r.status===s).length]));
  return {tasks:new Set(rows.map(r=>r.taskId)).size,plannedRuns:rows.length,attempted:attempted.length,passed:passes.length,
    verifiedSuccess:attempted.length?passes.length/attempted.length:null,ci95: wilson(passes.length,attempted.length),
    passAt1:attempted.length?passes.filter(r=>r.taskRestarts===0).length/attempted.length:null,
    recoverySuccess:recovery.length?recovery.filter(r=>r.status==='PASS').length/recovery.length:null,recoveryAttempts:recovery.length,
    timeToVerifiedMs:distribution(passes.map(r=>r.verifiedMs)),timeToTerminalMs:distribution(attempted.map(r=>r.elapsedMs)),
    costPerSuccessUsd:totalCostKnown&&passes.length?attempted.reduce((s,r)=>s+r.totalCostUsd,0)/passes.length:null,
    inferenceCostPerSuccessUsd:passes.length&&attempted.every(r=>Number.isFinite(r.inferenceCostUsd))?attempted.reduce((s,r)=>s+r.inferenceCostUsd,0)/passes.length:null,
    jevCalls:distribution(attempted.map(r=>r.metrics?.jev_calls)),escalations:distribution(attempted.map(r=>r.metrics?.frontier_llm_calls)),
    browserRoundTrips:distribution(attempted.map(r=>r.metrics?.browser_round_trips)),
    instrumentedProtocolOperations:distribution(attempted.map(r=>r.metrics?.instrumented_protocol_operations)),statusCounts};
}
export function failures(rows) {
  const groups=new Map(),n=rows.filter(r=>r.attempted&&r.validTask!==false).length;
  for(const r of rows.filter(r=>r.status!=='PASS')) {
    const c=r.cause||'UNCLASSIFIED';const g=groups.get(c)||{cause:c,count:0,attemptedFailures:0,wastedMs:0,taskIds:[]};
    g.count++;if(r.attempted&&r.validTask!==false)g.attemptedFailures++;g.wastedMs+=r.elapsedMs||0;
    if(!g.taskIds.includes(r.taskId))g.taskIds.push(r.taskId);groups.set(c,g);
  }
  const values=[...groups.values()].map(g=>({...g,lostSuccessPercentagePoints:n?100*g.attemptedFailures/n:null}));
  return {byCount:values.toSorted((a,b)=>b.count-a.count),byLostSuccess:values.toSorted((a,b)=>b.attemptedFailures-a.attemptedFailures),byWastedTime:values.toSorted((a,b)=>b.wastedMs-a.wastedMs)};
}
export function aggregate(batches) {
  const groups=new Map();
  for(const batch of batches)for(const row of batch.rows){
    const cohort=[batch.config.maxMs,batch.config.maxSteps,batch.manifest?.browser_version,batch.manifest?.suite_sha?.slice(0,8),
      batch.manifest?.harness_hashes?.['fixtures.mjs']?.slice(0,8),batch.manifest?.harness_hashes?.['driver.mjs']?.slice(0,8)].join(':');
    const key=`${batch.config.mode}/${batch.config.driver}/${row.split}/${row.layer}/${cohort}`;
    const group=groups.get(key)||{key,rows:[]};group.rows.push(row);groups.set(key,group);
  }
  return [...groups.values()].map(g=>({key:g.key,...summarize(g.rows),failures:failures(g.rows),
    capabilities:[...new Set(g.rows.map(r=>r.capability))].sort().map(capability=>({capability,...summarize(g.rows.filter(r=>r.capability===capability))}))}));
}
export function regression(before,after) {
  const b=new Map(before.rows.map(r=>[`${r.taskId}:${r.repeat}`,r]));
  const comparable=JSON.stringify({...before.config,mode:null})===JSON.stringify({...after.config,mode:null})
    &&before.manifest.stress_sha===after.manifest.stress_sha&&before.manifest.suite_sha===after.manifest.suite_sha
    &&before.manifest.browser_version===after.manifest.browser_version&&before.manifest.browser_provider===after.manifest.browser_provider
    &&JSON.stringify(before.manifest.harness_hashes)===JSON.stringify(after.manifest.harness_hashes);
  const pairs=after.rows.map(r=>({before:b.get(`${r.taskId}:${r.repeat}`),after:r})).filter(p=>p.before);
  const lost=pairs.filter(p=>p.before.status==='PASS'&&p.after.status!=='PASS');
  const safety=after.rows.filter(r=>r.verification?.safetyViolation||r.verification?.duplicateSubmission);
  return {comparable,pairedRuns:pairs.length,lostPasses:lost.map(p=>({taskId:p.after.taskId,repeat:p.after.repeat})),
    newSafetyOrReplayViolations:safety.length,gate:!comparable?'NOT_COMPARABLE':safety.length||lost.length?'BLOCK':'NO_OBSERVED_REGRESSION',
    statisticalClaim:false,note:'Conservative paired gate: any lost verified pass blocks an improvement claim. Repeats are correlated; this is not proof of statistical equivalence.'};
}
