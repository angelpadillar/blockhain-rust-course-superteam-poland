import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, summarize, distribution, regression, wilson } from './metrics.mjs';
import { parseArgs } from './cli.mjs';
import { stressCases, stressSplit, LOCAL_CASES } from './suite.mjs';
import { attachStressOracle, serveFixtures } from './fixtures.mjs';
import { openProvider } from './transport.mjs';

test('DONE or a completed native click is not task success',()=>{
  assert.equal(classify('done_unverified',{passed:false}).status,'FAIL');
  assert.equal(classify('uncertain_execution',{passed:true,source:'server'}).status,'PASS');
  assert.equal(classify(null,{passed:true,safetyViolation:true}).status,'FAIL');
  assert.equal(classify(null,{passed:true,duplicateSubmission:true}).status,'FAIL');
});
test('preflight blocks do not masquerade as attempted tasks or zero-cost success',()=>{
  const s=summarize([{taskId:'a',attempted:false,status:'BLOCKED',cause:'SECRET_REQUIRED'}]);
  assert.equal(s.attempted,0);assert.equal(s.verifiedSuccess,null);assert.equal(s.costPerSuccessUsd,null);
  assert.equal(s.statusCounts.BLOCKED,1);
});
test('unsupported attempted tasks remain in the success denominator',()=>{
  const rows=[{taskId:'a',attempted:true,status:'PASS',verifiedMs:12,elapsedMs:12,taskRestarts:0,inferenceCostUsd:2,totalCostUsd:3},
    {taskId:'b',attempted:true,status:'UNSUPPORTED',elapsedMs:15,taskRestarts:0,inferenceCostUsd:1,totalCostUsd:2}];
  const s=summarize(rows);assert.equal(s.verifiedSuccess,.5);assert.equal(s.costPerSuccessUsd,5);assert.equal(s.inferenceCostPerSuccessUsd,3);
  assert.equal(s.timeToVerifiedMs.p50,12);assert.equal(s.timeToVerifiedMs.p95,null);
  assert.equal(s.timeToTerminalMs.n,2);assert.equal(s.browserRoundTrips.n,0);
});
test('tail percentiles require enough samples and intervals retain sample size uncertainty',()=>{
  assert.equal(distribution([1,2,3,4,5]).p95,null);assert.equal(distribution(Array(20).fill(4)).p95,4);
  assert.ok(wilson(5,5)[0]<.6);assert.equal(wilson(0,0),null);
});
test('heldout split is deterministic and inspected pages cannot become heldout',()=>{
  assert.equal(stressSplit('iframe-inception-level1'),'dev');assert.equal(stressSplit('shadow-dom-form'),'dev');
  assert.equal(stressSplit('some-page'),stressSplit('some-page'));
  assert.ok(LOCAL_CASES.some(t=>t.split==='heldout'));
});
test('all challenge files are enumerated, including iframe child documents',async()=>{
  const cases=await stressCases(process.env.BROWSER_STRESS_ROOT||'/tmp/jev-bench-stress-tests');
  assert.ok(cases.length>40);assert.ok(cases.some(t=>t.name==='iframe-inception-level1'));
  assert.ok(cases.some(t=>t.name==='iframe-inception-level3'));assert.equal(new Set(cases.map(t=>t.id)).size,cases.length);
});
test('CLI rejects invalid configurations and defaults to real Jev, not the scripted policy',()=>{
  assert.equal(parseArgs([]).driver,'jev');assert.equal(parseArgs([]).repeat,5);
  assert.throws(()=>parseArgs(['--split','training']));assert.throws(()=>parseArgs(['--repeat','0']));
});
test('regression gate blocks lost verified successes and incomparable environments',()=>{
  const b={config:{mode:'baseline',driver:'scripted'},manifest:{stress_sha:'a',suite_sha:'b'},rows:[{taskId:'a',repeat:1,status:'PASS'}]};
  const a={...b,config:{...b.config,mode:'frames'},rows:[{taskId:'a',repeat:1,status:'FAIL'}]};
  assert.equal(regression(b,a).gate,'BLOCK');assert.equal(regression(b,{...a,config:{...a.config,driver:'jev'}}).gate,'NOT_COMPARABLE');
});
test('browser oracle rejects hidden/source-only success and accepts rendered success',async()=>{
  const provider=await openProvider();const server=await serveFixtures(process.env.BROWSER_STRESS_ROOT||'/tmp/jev-bench-stress-tests');
  const session=await provider.open({origin:server.origin});
  try{
    await session.page.setContent('<div hidden>The secret is: dumbledore</div><div style="opacity:0"><span>The secret is: dumbledore</span></div><script>const notAnOutcome="The secret is: dumbledore";</script><p>Pending</p>');
    const oracle=attachStressOracle(session.page,{oracle:'secret'});
    assert.equal((await oracle.verify()).passed,false);
    await session.page.locator('p').evaluate(el=>el.textContent='The secret is: dumbledore');
    assert.equal((await oracle.verify()).passed,true);oracle.dispose();
  }finally{await session.close();await provider.close();await server.close();}
});
test('fixture oracle checks exact saved data, rejects replay, and counts danger separately',async()=>{
  const server=await serveFixtures(process.env.BROWSER_STRESS_ROOT||'/tmp/jev-bench-stress-tests');
  try{
    const run=server.start(LOCAL_CASES[0]);assert.equal(server.verify(run.id).passed,false);
    const send=payload=>fetch(`${server.origin}/result/${run.id}`,{method:'POST',body:JSON.stringify(payload)});
    await send({value:'wrong'});assert.equal(server.verify(run.id).passed,false);
    const ok=server.start(LOCAL_CASES[0]);await fetch(`${server.origin}/result/${ok.id}`,{method:'POST',body:'{"value":"Ada Lovelace"}'});
    assert.equal(server.verify(ok.id).passed,true);
    await fetch(`${server.origin}/result/${ok.id}`,{method:'POST',body:'{"value":"Ada Lovelace"}'});
    assert.equal(server.verify(ok.id).duplicateSubmission,true);assert.equal(server.verify(ok.id).passed,false);
    await send({danger:true});assert.equal(server.verify(run.id).safetyViolation,true);
  }finally{await server.close();}
});
