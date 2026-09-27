import test from 'node:test';
import assert from 'node:assert/strict';
import { openProvider } from '../bench/transport.mjs';
import { serveFixtures } from '../bench/fixtures.mjs';
import { createSession, StaleBeforeDispatch } from '../experimental/browser-runtime-v6/session.mjs';
import { runLoop } from '../experimental/browser-runtime-v6/runtime.mjs';
import { parseArgs, runBench } from '../bench/cli.mjs';

function metrics() {return {protocolCalls:0,snapMs:0,observations:0,observerWakeups:0,browserScans:0,revalidations:0,nativeActionAttempts:0,nativeActionsCompleted:0,actMs:0};}
async function setup(kind,allowCross=false) {
  const provider=await openProvider(),server=await serveFixtures(process.env.BROWSER_STRESS_ROOT||'/tmp/jev-bench-stress-tests');
  const browser=await provider.open({origin:server.origin,additionalOrigins:server.additionalOrigins});
  const run=server.start({name:kind});await browser.page.goto(run.url,{waitUntil:'load'});
  const m=metrics(),session=createSession(browser.page,server.origin,{},m,new AbortController().signal,{allowedUrl:url=>new URL(url).origin===server.origin,
    ...(allowCross?{allowedFrameUrl:url=>[server.origin,...server.additionalOrigins].includes(new URL(url).origin)}:{})});
  return {page:browser.page,session,m,server,run,async close(){await session.dispose();await browser.close();await provider.close();await server.close();}};
}
for(const kind of ['native-form','iframe','nested-iframe','cross-origin-iframe','shadow','nested-shadow'])test(`fresh semantic refs execute and independently verify ${kind}`,async()=>{
  const env=await setup(kind,kind==='cross-origin-iframe');
  try{
    const snap=await env.session.capture();
    const field=env.session.candidates(snap,['fill']).find(c=>c.what==='Display name');assert.ok(field);
    await env.session.execute(snap,field,'fill','Ada Lovelace',1500);
    const fresh=await env.session.capture(),save=env.session.candidates(fresh,['click']).find(c=>c.what==='Save draft');assert.ok(save);
    const response=env.page.waitForResponse(r=>r.url().endsWith(`/result/${env.run.id}`)&&r.request().method()==='POST');
    await env.session.execute(fresh,save,'click','',1500);await response;
    assert.equal(env.server.verify(env.run.id).passed,true);
    await assert.rejects(env.session.execute(fresh,save,'click','',1500),StaleBeforeDispatch);
    assert.equal(env.server.verify(env.run.id).recordCount,1);
  }finally{await env.close();}
});
test('cross-origin frame discovery requires an explicit grant',async()=>{
  const env=await setup('cross-origin-iframe');try{
    const snap=await env.session.capture();assert.equal(snap.data.controls.length,0);assert.equal(snap.data.inaccessibleFrames,1);
  }finally{await env.close();}
});
test('identical-looking replacement nodes invalidate prior handles without dispatch',async()=>{
  const env=await setup('native-form');try{
    const snap=await env.session.capture(),field=env.session.candidates(snap,['fill']).find(c=>c.what==='Display name');
    await env.page.locator('input').evaluate(el=>el.replaceWith(el.cloneNode(true)));
    await assert.rejects(env.session.execute(snap,field,'fill','Ada Lovelace',1500),StaleBeforeDispatch);
    assert.equal(env.m.nativeActionAttempts,0);assert.equal(env.server.verify(env.run.id).recordCount,0);
  }finally{await env.close();}
});
test('semantic changes to the same node invalidate a prior action',async()=>{
  const env=await setup('native-form');try{
    const snap=await env.session.capture(),save=env.session.candidates(snap,['click']).find(c=>c.what==='Save draft');
    await env.page.getByRole('button',{name:'Save draft',exact:true}).evaluate(el=>el.textContent='Delete draft');
    await assert.rejects(env.session.execute(snap,save,'click','',1500),StaleBeforeDispatch);
    assert.equal(env.m.nativeActionAttempts,0);
  }finally{await env.close();}
});
test('frame document navigation invalidates a descendant reference',async()=>{
  const env=await setup('nested-iframe');try{
    const snap=await env.session.capture(),field=env.session.candidates(snap,['fill']).find(c=>c.what==='Display name');
    const leaf=env.page.frames().at(-1);await leaf.goto(leaf.url(),{waitUntil:'load'});
    await assert.rejects(env.session.execute(snap,field,'fill','Ada Lovelace',1500),StaleBeforeDispatch);
    assert.equal(env.m.nativeActionAttempts,0);
  }finally{await env.close();}
});
test('a hidden shadow host cannot contribute actionable descendants',async()=>{
  const env=await setup('shadow');try{
    await env.page.locator('draft-editor').evaluate(el=>el.style.opacity='0');
    const snap=await env.session.capture();assert.equal(snap.data.controls.length,0);
  }finally{await env.close();}
});
test('child-frame no-op is not misreported as navigation from the top document',async()=>{
  const env=await setup('nested-iframe');try{
    const leaf=env.page.frames().at(-1);
    await leaf.evaluate(()=>{const b=document.createElement('button');b.textContent='Inspect';document.body.append(b);});
    const snap=await env.session.capture(),inspect=env.session.candidates(snap,['click']).find(c=>c.what==='Inspect');
    const before=await env.session.execute(snap,inspect,'click','',1500);
    const after=await env.session.capture({baseline:before,goal:{type:'change',beforeUrl:snap.data.url,beforeTitle:snap.data.title},waitMs:30});
    assert.equal(after.data.ready,false);
  }finally{await env.close();}
});
test('postcondition keeps target identity when an unrelated control shifts DOM indexes',async()=>{
  const env=await setup('native-form');try{
    const snap=await env.session.capture(),field=env.session.candidates(snap,['fill']).find(c=>c.what==='Display name');
    await env.page.locator('input').evaluate(el=>{const other=document.createElement('input');other.setAttribute('aria-label','Unrelated field');el.parentElement.before(other);});
    const before=await env.session.execute(snap,field,'fill','Ada Lovelace',1500);
    const after=await env.session.capture({baseline:before,goal:{type:'value',nodeIndex:field.nodeIndex,value:'Ada Lovelace'},waitMs:30});
    assert.equal(after.data.ready,true);
  }finally{await env.close();}
});
test('changing wrapped-label ownership invalidates the previous semantic reference',async()=>{
  const env=await setup('native-form');try{
    const snap=await env.session.capture(),field=env.session.candidates(snap,['fill']).find(c=>c.what==='Display name');
    await env.page.locator('input').evaluate(el=>{const other=document.createElement('input');other.setAttribute('aria-label','Other field');el.before(other);});
    await assert.rejects(env.session.execute(snap,field,'fill','Ada Lovelace',1500),StaleBeforeDispatch);
    assert.equal(env.m.nativeActionAttempts,0);
  }finally{await env.close();}
});
test('an uncertain dispatch consumes the whole composite snapshot',async()=>{
  const env=await setup('iframe');try{
    await env.page.evaluate(()=>{const b=document.createElement('button');b.textContent='Inspect parent';document.body.prepend(b);});
    const snap=await env.session.capture(),choices=env.session.candidates(snap,['click']);
    const save=choices.find(c=>c.what==='Save draft'),inspect=choices.find(c=>c.what==='Inspect parent');
    await env.page.evaluate(()=>{const cover=document.createElement('div');cover.id='test-cover';cover.style.cssText='position:fixed;inset:0;z-index:99999;background:white';document.body.append(cover);});
    await assert.rejects(env.session.execute(snap,save,'click','',100),e=>e.code==='uncertain_execution');
    await env.page.locator('#test-cover').evaluate(el=>el.remove());
    await assert.rejects(env.session.execute(snap,inspect,'click','',1500),StaleBeforeDispatch);
    assert.equal(env.m.nativeActionAttempts,1);assert.equal(env.server.verify(env.run.id).recordCount,0);
  }finally{await env.close();}
});
test('file inputs surface as upload targets and a declared file verifies end to end',async()=>{
  const env=await setup('file-upload');try{
    const filePath=new URL('../bench/files/benchmark-upload.txt',import.meta.url).pathname;
    const snap=await env.session.capture(),input=env.session.candidates(snap,['upload']).find(c=>c.what==='Attachment');
    assert.ok(input);
    await env.session.execute(snap,input,'upload',filePath,1500);
    const fresh=await env.session.capture(),save=env.session.candidates(fresh,['click']).find(c=>c.what==='Save draft');
    const response=env.page.waitForResponse(r=>r.url().endsWith(`/result/${env.run.id}`)&&r.request().method()==='POST');
    await env.session.execute(fresh,save,'click','',1500);await response;
    assert.equal(env.server.verify(env.run.id).passed,true);
  }finally{await env.close();}
});
test('official iframe-inception-level1 completes through the general kernel and independent oracle',async()=>{
  const {batch}=await runBench(parseArgs(['--mode','frames','--driver','scripted','--suite','stress','--split','dev','--only','iframe-inception-level1','--repeat','1','--max-ms','15000','--max-steps','25']));
  assert.equal(batch.rows.length,1);assert.equal(batch.rows[0].status,'PASS');assert.equal(batch.sourceUnchanged,true);
});
test('local file-upload task completes through the loop with a declared file',async()=>{
  const {batch}=await runBench(parseArgs(['--mode','frames','--driver','scripted','--suite','local','--split','dev','--only','file-upload','--repeat','1','--max-ms','15000','--max-steps','25']));
  assert.equal(batch.rows.length,1);assert.equal(batch.rows[0].status,'PASS');
});
test('one decide call assigns a whole form and submits it',async()=>{
  const env=await setup('duplicate-labels');
  try{
    const controller=new AbortController();let calls=0;
    const decide=async request=>{
      calls++;
      const answers={goal_met:{type:'noul',probability:0},destructive:{type:'noul',probability:0}};
      for(const [key,meta] of request.plan.items){
        const wanted=meta.op==='fill'&&/other record/i.test(meta.control.component?.label||'')?'none'
          :Object.keys(meta.question.criteria)[0];
        answers[key]={type:'choice',choice:wanted,probabilities:{[wanted]:1},confidence:1};
      }
      const sub=Object.entries(request.plan.submitChoices).find(([key,ref])=>{
        const atom=request.actions.find(a=>a.ref===ref);
        return /draft editor/i.test(atom?.item?.control?.component?.label||'');
      });
      answers.submit={type:'choice',choice:sub?.[0]||'none',probabilities:{},confidence:1};
      answers.action={type:'choice',choice:'fill_form',probabilities:{fill_form:1},confidence:1};
      return answers;
    };
    await runLoop({page:env.page,decide,signal:controller.signal,maxMs:15000,maxSteps:10,maxActions:20,maxModelCalls:5,
      spec:{goal:'Set the Display name to Ada Lovelace and save the draft. Do not delete, publish, or send anything.',
        values:{text:'Ada Lovelace'},files:{},
        policy:{allowDestructive:true,deny:['delete','publish','transfer','buy now','pay now'],denyPath:'',avoid:['delete|publish|transfer|buy now|pay now']}},
      requestFilter:request=>{try{return new URL(request.url()).origin===env.server.origin?'allow':'fatal';}catch{return 'fatal';}},
      onEvent:async event=>{if(event.type==='step_completed'&&env.server.verify(env.run.id).passed)controller.abort('oracle_verified');}});
    // The whole form — fill plus submit — landed in a single model call.
    assert.equal(calls,1);
    assert.equal(env.server.verify(env.run.id).passed,true);
  }finally{await env.close();}
});
