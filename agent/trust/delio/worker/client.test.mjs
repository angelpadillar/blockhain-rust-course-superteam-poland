import test from 'node:test';
import assert from 'node:assert/strict';
import {runClient} from './client.mjs';
const readToken=async()=> 'a'.repeat(64);
test('parsed known blocker exits zero and preserves usage/no-dispatch evidence',async()=>{
 const response={ok:false,code:'merchant_login_required',dispatched:false,blockers:[],result:{usage:{modelCalls:0,modelCostUsd:0}}};
 const result=await runClient('{"operation":"observeCart"}',{readToken,fetchImpl:async()=>({json:async()=>response})});
 assert.deepEqual(result,{response,exitCode:0});
});
test('parsed success exits zero',async()=>{
 const response={ok:true,result:{status:'blocked'}};
 assert.deepEqual(await runClient('{"operation":"status"}',{readToken,fetchImpl:async()=>({json:async()=>response})}),{response,exitCode:0});
});
test('transport failure exits nonzero without claiming no dispatch',async()=>{
 const result=await runClient('{"operation":"mutateCart","lines":[]}',{readToken,fetchImpl:async()=>{throw new Error('private transport detail');}});
 assert.equal(result.exitCode,1);assert.equal(result.response.code,'worker_transport_uncertain');assert.equal(Object.hasOwn(result.response,'dispatched'),false);assert.ok(!JSON.stringify(result).includes('private transport detail'));
});
test('unreadable server reply is uncertain, not invalid client input',async()=>{
 const result=await runClient('{"operation":"status"}',{readToken,fetchImpl:async()=>({json:async()=>{throw new SyntaxError('bad JSON');}})});
 assert.equal(result.exitCode,1);assert.equal(result.response.code,'worker_transport_uncertain');assert.equal(Object.hasOwn(result.response,'dispatched'),false);
});
test('invalid input stops before reading credentials or making a request',async()=>{
 let called=false;const result=await runClient('{"operation":"click"}',{readToken:async()=>{called=true;return '';},fetchImpl:async()=>{called=true;}});
 assert.equal(called,false);assert.equal(result.exitCode,1);assert.equal(result.response.code,'invalid_request');assert.equal(result.response.dispatched,false);
});
