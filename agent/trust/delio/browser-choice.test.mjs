import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mailboxChoiceRequest,validateMailboxDecision,createOnboardingJev} from './browser-choice.mjs';
const input={task:'mailbox_open',origin:'https://fviainboxes.com',snapshotId:'snapshot-1',controls:[{ref:'get_email',role:'button',name:'Get Email',visible:true,frameOrigin:'https://fviainboxes.com',value:'secret@example.test'}, {ref:'ad',role:'button',name:'Get Email',visible:true,frameOrigin:'https://ads.test'}]};
test('only a grounded first-party control enters the request; input values and advertisements are excluded',()=>{
 const request=mailboxChoiceRequest(input);assert.deepEqual(Object.keys(request.state.controls),['get_email']);assert.ok(!JSON.stringify(request).includes('secret'));assert.ok(!JSON.stringify(request).includes('ads.test'));
 assert.throws(()=>mailboxChoiceRequest({...input,origin:'https://evil.test'}),{code:'browser_choice_scope_mismatch'});
 assert.throws(()=>mailboxChoiceRequest({...input,controls:[...input.controls,input.controls[0]]}),{code:'browser_choice_missing_or_ambiguous_control'});
});
test('stale, invented, missing and low-probability target choices never execute',()=>{
 const request=mailboxChoiceRequest(input);const response={answers:{target:{choice:'get_email',probabilities:{get_email:0.99}}}};
 assert.equal(validateMailboxDecision({request,response,currentSnapshotId:'snapshot-1'}).command,'click');
 assert.throws(()=>validateMailboxDecision({request,response,currentSnapshotId:'snapshot-2'}),{code:'browser_choice_stale_snapshot'});
 for(const choice of ['ad','unknown'])assert.throws(()=>validateMailboxDecision({request,response:{answers:{target:{choice,probabilities:{[choice]:1}}}},currentSnapshotId:'snapshot-1'}),{code:'browser_choice_unverified_decision'});
 assert.throws(()=>validateMailboxDecision({request,response:{answers:{target:{choice:'none'}}},currentSnapshotId:'snapshot-1'}),{code:'browser_choice_no_match'});
});
test('bounded Jev requests keep usage measured and monetary cost unknown without a rate',async t=>{
 const storeDir=mkdtempSync(join(tmpdir(),'delio-jev-'));t.after(()=>rmSync(storeDir,{recursive:true,force:true}));
 let calls=0;const decide=createOnboardingJev({apiKey:'fictional-api-key',storeDir,maxCalls:1,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(options.redirect,'error');return {ok:true,json:async()=>({answers:{},usage:{input_tokens:10,output_tokens:2}})};}});
 const result=await decide(mailboxChoiceRequest(input));assert.equal(result.modelCostUsd,null);assert.equal(result.usage.input_tokens,10);
 await assert.rejects(()=>decide(mailboxChoiceRequest(input)),{code:'browser_choice_budget_exhausted'});assert.equal(calls,1);
});
test('failed provider attempts consume the durable allowance across helper recreation',async t=>{
 const storeDir=mkdtempSync(join(tmpdir(),'delio-jev-'));t.after(()=>rmSync(storeDir,{recursive:true,force:true}));
 const config={apiKey:'fictional-api-key',storeDir,maxCalls:1,fetchImpl:async()=>{throw new Error('fixture network failure');}};
 await assert.rejects(()=>createOnboardingJev(config)(mailboxChoiceRequest(input)));
 assert.equal(JSON.parse(readFileSync(join(storeDir,'jev-attempts.json'))).attempts[0].phase,'failed_cost_unknown');
 await assert.rejects(()=>createOnboardingJev(config)(mailboxChoiceRequest(input)),{code:'browser_choice_budget_exhausted'});
});
