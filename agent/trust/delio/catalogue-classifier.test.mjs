import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {classificationRequest,classificationResults,classifyCatalogue} from './catalogue-classifier.mjs';
const items=[{productId:'A0000953',title:'Masło',packSize:'200 g'}];
const response={model:'jev-1.13.0',answers:{A0000953:{type:'choice',choice:'dairy',confidence:0.98,probabilities:{dairy:0.99,other:0.01}}},usage:{input_tokens:100,output_tokens:1}};
test('classifier sends only product text, asks scoped choice and rejects unsupported or uncertain outcomes',()=>{
 const req=classificationRequest([{...items[0],email:'PRIVATE',priceMinor:399}]);assert.doesNotMatch(JSON.stringify(req),/PRIVATE|priceMinor/);
 assert.equal(classificationResults(req,response)[0].categoryId,'dairy');
 for(const answer of [{...response.answers.A0000953,choice:'payment_approved'},{...response.answers.A0000953,confidence:0.1},{...response.answers.A0000953,probabilities:{dairy:0.4}}])assert.equal(classificationResults(req,{answers:{A0000953:answer}})[0].categoryId,'other');
});
test('cache avoids repeat costs; changed product text invalidates it and respects the finite budget',async()=>{
 const storeDir=mkdtempSync(join(tmpdir(),'grocery-jev-'));let calls=0;
 try{
 const opts={items,apiKey:'test-key-not-real',storeDir,maxCalls:2,fetchImpl:async()=>{calls++;return {ok:true,json:async()=>response};}};
 const first=await classifyCatalogue(opts);assert.ok(Math.abs(first.measurement.estimatedModelCostUsd-0.0000042)<1e-12);
 await classifyCatalogue(opts);assert.equal(calls,1);
 await classifyCatalogue({...opts,items:[{...items[0],title:'Masło polskie'}]});assert.equal(calls,2);
 const exhausted=await classifyCatalogue({...opts,items:[{...items[0],title:'Changed again'}]});assert.equal(calls,2);assert.equal(exhausted.items[0].classification.status,'not_classified');
 }finally{rmSync(storeDir,{recursive:true,force:true});}
});
