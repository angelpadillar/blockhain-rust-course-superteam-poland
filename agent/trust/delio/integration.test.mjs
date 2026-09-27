import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPilot } from './core.mjs';
import { createDelioServer } from './server.mjs';
import { createDelioAdapter } from './adapter.mjs';
import { createLocalAuthorizer, verifyQuoteEvidence, quoteObservation } from './authorization.mjs';
import { costReport } from './costs.mjs';

const account={customerId:'owner-a',merchantAccountId:'delio-a',accessCode:'fictional-test-access-code-a',deliveryCommitment:'ab'.repeat(32),allowance:{liveQuotes:3,cartUpdates:5,modelCalls:0,runtimeMs:60000}};
const other={...account,customerId:'owner-b',merchantAccountId:'delio-b',accessCode:'fictional-test-access-code-b'};
const actor=({customerId,merchantAccountId})=>({customerId,merchantAccountId});
function fixture(overrides={},clock=Date.now) {
  let calls=0;
  const carts=new Map([[account.merchantAccountId,[]],[other.merchantAccountId,[]]]);
  const observation=id=>({verified:true,observedAt:clock(),evidenceRefs:[{id:'fixture-checkout',observedAt:clock()}],lines:structuredClone(carts.get(id)),usage:{modelCalls:0,modelCostUsd:0}});
  const adapter={getAccess:()=>({status:'ready',blockers:[]}),catalog:async()=>({items:[{productId:'fixture-pasta',title:'Fictional test pasta',unitPriceMinor:500}]}),
    async observeCart({accountId}){calls++;return observation(accountId);},
    async mutateCart({accountId,lines}){calls++;carts.set(accountId,structuredClone(lines));return observation(accountId);},
    async applyCoupon(){calls++;return {coupon:{accepted:true,code:'z5913',discountMinor:0}};},
    async quote({accountId,delivery}){calls++;const result=observation(accountId),subtotal=result.lines.reduce((sum,line)=>sum+line.quantity*500,0);
      return {...result,deliveryCommitment:delivery,currency:'PLN',expiresAt:clock()+120000,lines:result.lines.map(line=>({...line,unitPriceMinor:500,lineTotalMinor:line.quantity*500})),
        amounts:{itemSubtotalMinor:subtotal,deliveryFeeMinor:100,serviceFeeMinor:20,smallOrderFeeMinor:0,otherFeesMinor:0,depositsMinor:0,discountMinor:0,merchantTotalMinor:subtotal+120}};}
  };
  const pilot=createPilot({adapter,accounts:[{...account,...overrides},other],clock});
  return {adapter,pilot,calls:()=>calls};
}

test('HTTP authentication, ownership, Origin, precise intent and allowance cannot be bypassed by clients',async t=>{
  const f=fixture();let authorizations=0;
  const server=createDelioServer({...f,accounts:[account,other],authorizer:async()=>{authorizations++;return {accepted:true,proof:{backend:'test-only'}};}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const origin='http://127.0.0.1:'+server.address().port;
  const request=async(path,{cookie='',method='GET',data,requestOrigin=origin}={})=>{
    const r=await fetch(origin+path,{method,headers:{Origin:requestOrigin,Cookie:cookie,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],value:await r.json()};
  };
  const publicState=await request('/api/state');assert.equal(publicState.value.authenticated,false);assert.deepEqual(publicState.value.state,{});assert.equal(f.calls(),0);
  assert.equal((await request('/api/check-access',{method:'POST',data:{}})).status,401);assert.equal(f.calls(),0);
  const a=await request('/api/session',{method:'POST',data:{accessCode:account.accessCode}});assert.equal(a.status,200);assert.ok(a.cookie);
  const b=await request('/api/session',{method:'POST',data:{accessCode:other.accessCode}});
  assert.equal((await request('/api/check-access',{cookie:a.cookie,method:'POST',data:{},requestOrigin:'https://evil.test'})).status,403);assert.equal(f.calls(),0);
  let r=await request('/api/check-access',{cookie:a.cookie,method:'POST',data:{}});assert.equal(r.value.state.version,1);
  r=await request('/api/cart',{cookie:a.cookie,method:'POST',data:{version:1,lines:[{productId:'fixture-pasta',quantity:2,unitPriceMinor:1}]}});assert.equal(r.value.code,'invalid_request_fields');
  r=await request('/api/cart',{cookie:a.cookie,method:'POST',data:{version:1,lines:[{productId:'fixture-pasta',quantity:2}],customerId:other.customerId}});assert.equal(r.value.code,'invalid_request_fields');
  r=await request('/api/cart',{cookie:a.cookie,method:'POST',data:{version:1,lines:[{productId:'fixture-pasta',quantity:2}]}});assert.equal(r.value.state.version,2);
  const q=await request('/api/quote',{cookie:a.cookie,method:'POST',data:{version:2}});assert.equal(q.value.state.quote.amounts.totalMinor,1120);
  r=await request('/api/authorize',{cookie:b.cookie,method:'POST',data:{quoteId:q.value.state.quote.quoteId,version:2}});assert.equal(r.value.code,'stale_cart_version');assert.equal(authorizations,0);
  r=await request('/api/authorize',{cookie:a.cookie,method:'POST',data:{quoteId:q.value.state.quote.quoteId,version:2}});assert.equal(r.value.state.authorization.status,'authorized');assert.equal(authorizations,1);
  r=await request('/api/execute',{cookie:a.cookie,method:'POST',data:{}});assert.equal(r.status,404);
  await request('/api/session',{cookie:a.cookie,method:'DELETE'});assert.equal((await request('/api/evidence',{cookie:a.cookie})).status,401);
});

test('Delio adapter refuses unknown products and retains a known access blocker without an uncertain mutation',async()=>{
  let calls=0;
  const adapter=createDelioAdapter({accountId:account.merchantAccountId,invoke:async()=>{calls++;return {ok:false,code:'delivery_unavailable',dispatched:false,blockers:[{code:'delivery_unavailable',message:'The selected address is outside the observed delivery area.'}]};}});
  await assert.rejects(()=>adapter.mutateCart({accountId:account.merchantAccountId,lines:[{productId:'invented',quantity:1}]}),{code:'unknown_product_id'});assert.equal(calls,0);
  const pilot=createPilot({adapter,accounts:[account]});
  await assert.rejects(()=>pilot.reconcile(actor(account)),{code:'delivery_unavailable'});
  assert.equal(pilot.getState(actor(account)).cart.status,'unobserved');assert.equal(adapter.getAccess().status,'blocked');assert.equal(calls,1);
});

test('a failed state or cost read returns a bounded error instead of crashing the HTTP process',async t=>{
  const f=fixture();const server=createDelioServer({...f,accounts:[account],authorizer:async()=>{},readCosts:()=>{throw new Error('private journal parse detail');}});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const origin='http://127.0.0.1:'+server.address().port;
  const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessCode:account.accessCode})});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const r=await fetch(origin+'/api/state',{headers:{Cookie:cookie}});assert.equal(r.status,409);assert.deepEqual(await r.json(),{ok:false,code:'request_failed'});
  assert.equal((await fetch(origin+'/api/state')).status,200);
});

test('cost per verified success includes failed and abandoned attempts, and missing costs remain unknown',()=>{
  const attempts=[{type:'worker_end',runtimeMs:100,cost:{status:'known',amountUsd:0.1}},{type:'worker_end',runtimeMs:50,cost:{status:'known',amountUsd:0.2}}];
  let report=costReport({attempts,verifiedQuotes:1});assert.equal(report.totalVariableCostUsd,null);assert.equal(report.contributionMarginUsd,null);assert.equal(report.browserRuntimeMs,150);
  report=costReport({attempts,verifiedQuotes:1,completedOrders:1,smsSpentUsd:0.2,revenueUsd:1,infrastructureUsd:0.1,manualSupportUsd:0.1,paymentAndFxUsd:0.1});
  assert.ok(Math.abs(report.costPerVerifiedQuoteUsd-0.8)<1e-9);assert.ok(Math.abs(report.contributionMarginUsd-0.2)<1e-9);
  assert.equal(costReport({attempts:[]}).costPerVerifiedQuoteUsd,null);
  const interrupted=costReport({attempts:[{type:'worker_start',attemptId:'missing-end',reserved:{runtimeMs:30000}}]});
  assert.equal(interrupted.attempts,1);assert.equal(interrupted.unknownAttempts,1);assert.equal(interrupted.browserRuntimeMs,null);assert.equal(interrupted.totalVariableCostUsd,null);
});

test('actual reviewed SBF authorizes the full fictional grocery quote on local LiteSVM; no merchant execution',async()=>{
  const f=fixture();let state=await f.pilot.reconcile(actor(account));
  state=await f.pilot.updateCart(actor(account),{version:state.version,lines:[{productId:'fixture-pasta',quantity:2}]});
  state=await f.pilot.refreshQuote(actor(account),{version:state.version});
  const local=createLocalAuthorizer({verifyEvidence:()=>[{id:'fixture-evidence-only',observedAt:state.quote.observedAt,imageSha256:'11'.repeat(32),observationSha256:'22'.repeat(32)}]});
  state=await f.pilot.authorizeQuote(actor(account),{version:state.version,quoteId:state.quote.quoteId},local);
  assert.equal(state.authorization.status,'authorized');
  const p=state.authorization.proof;assert.equal(p.backend,'LiteSVM local Solana');assert.equal(p.state.campaign.status,'Approved');assert.equal(p.state.mandate.status,'Active');
  assert.equal(p.canonical.inputs.campaign.quotedChargeAmountMinor,'1120');assert.equal(p.merchantExecution,'not_requested');assert.equal(p.funding.realFunds,false);
  assert.ok(p.transactions.every(tx=>tx.accepted));
});

test('quote evidence requires matching bytes, owner and complete observed fee breakdown',async()=>{
  const f=fixture();let s=await f.pilot.reconcile(actor(account));s=await f.pilot.updateCart(actor(account),{version:s.version,lines:[{productId:'fixture-pasta',quantity:1}]});s=await f.pilot.refreshQuote(actor(account),{version:s.version});
  const dir=mkdtempSync(join(tmpdir(),'delio-evidence-'));
  try {
    const q=s.quote,ref=q.evidenceRefs[0],png=Buffer.from('89504e470d0a1a0a','hex'),obs=JSON.stringify(quoteObservation(q)),hash=value=>createHash('sha256').update(value).digest('hex');
    const record={...actor(account),observedAt:ref.observedAt,imageSha256:hash(png),observationSha256:hash(obs)};
    writeFileSync(join(dir,ref.id+'.png'),png);writeFileSync(join(dir,ref.id+'.observation.json'),obs);writeFileSync(join(dir,ref.id+'.json'),JSON.stringify(record));
    assert.equal(verifyQuoteEvidence(dir,q,actor(account)).length,1);
    assert.throws(()=>verifyQuoteEvidence(dir,q,actor(other)),{code:'evidence_owner_mismatch'});
    const changed=structuredClone(q);changed.amounts.deliveryFeeMinor++;assert.throws(()=>verifyQuoteEvidence(dir,changed,actor(account)),{code:'evidence_quote_mismatch'});
    writeFileSync(join(dir,ref.id+'.png'),'changed');assert.throws(()=>verifyQuoteEvidence(dir,q,actor(account)),{code:'evidence_hash_mismatch'});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('missing evidence stops before chain dispatch and does not permanently mark authorization uncertain',async()=>{
  const f=fixture();let state=await f.pilot.reconcile(actor(account));state=await f.pilot.updateCart(actor(account),{version:state.version,lines:[{productId:'fixture-pasta',quantity:1}]});state=await f.pilot.refreshQuote(actor(account),{version:state.version});
  let created=0;
  const authorize=createLocalAuthorizer({verifyEvidence:()=>{throw Object.assign(new Error('live_quote_evidence_not_available'),{code:'live_quote_evidence_not_available'});},createChain:()=>{created++;}});
  await assert.rejects(()=>f.pilot.authorizeQuote(actor(account),{version:state.version,quoteId:state.quote.quoteId},authorize),{code:'live_quote_evidence_not_available'});
  assert.equal(created,0);assert.equal(f.pilot.getState(actor(account)).authorization,null);
});

test('live stock policy binds the exact regional basket and refuses stale stock before authorization',async()=>{
  let now=Date.now();const f=fixture({requireStockProof:true,regionId:'krakow'},()=>now);
  let state=await f.pilot.reconcile(actor(account));state=await f.pilot.updateCart(actor(account),{version:state.version,lines:[{productId:'fixture-pasta',quantity:2}]});
  await assert.rejects(()=>f.pilot.refreshQuote(actor(account),{version:state.version}),{code:'stock_proof_missing'});
  const original=f.adapter.quote;
  f.adapter.quote=async context=>{const q=await original(context);return {...q,stockProof:{...actor(account),deliveryCommitment:account.deliveryCommitment,regionId:'krakow',fulfillmentAreaId:'fixture-krakow-area',observedAt:now,lines:q.lines.map(({productId,quantity})=>({productId,quantity,availableQuantity:quantity}))}};};
  state=await f.pilot.refreshQuote(actor(account),{version:state.version});assert.equal(state.quote.regionId,'krakow');assert.ok(quoteObservation(state.quote).stockProof);
  now+=30001;let called=0;
  await assert.rejects(()=>f.pilot.authorizeQuote(actor(account),{version:state.version,quoteId:state.quote.quoteId},async()=>{called++;return {accepted:true};}),{code:'stock_proof_stale'});
  assert.equal(called,0);assert.equal(f.pilot.getState(actor(account)).authorization,null);
});

test('coupon status is owned server data and catalogue module/images use the narrow public policy',async t=>{
  const f=fixture({couponCode:'z5913'}),configured={...account,couponCode:'z5913'};
  const server=createDelioServer({...f,accounts:[configured],authorizer:async()=>{}});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const origin='http://127.0.0.1:'+server.address().port;
  const response=await fetch(origin+'/catalogue-view.mjs');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.ok(response.headers.get('content-security-policy').includes("img-src 'self' data: blob: https://auth.privy.io https://explorer-api.walletconnect.com https://*.walletconnect.com https://*.walletconnect.org https://delio.com.pl;"));
  const publicState=await(await fetch(origin+'/api/state')).json();assert.equal(publicState.promotion,null);
  const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessCode:configured.accessCode})});
  const cookie=login.headers.get('set-cookie').split(';')[0];const owned=await(await fetch(origin+'/api/state',{headers:{Cookie:cookie}})).json();
  assert.equal(owned.promotion.code,'z5913');assert.equal(owned.promotion.merchantAccepted,false);assert.equal(owned.promotion.discountMinor,0);assert.equal(owned.promotion.expiryVerified,false);
});

test('grocery catalogue requires owned admission; reading and planning never call merchant cart operations',async t=>{
 const f=fixture();let groceryReads=0;
 const server=createDelioServer({...f,accounts:[account],readGroceries:who=>{assert.deepEqual(who,actor(account));groceryReads++;return {regionId:'krakow',items:[{productId:'A0000953',title:'Fictional product'}]};}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const origin='http://127.0.0.1:'+server.address().port;
 assert.equal((await fetch(origin+'/api/groceries')).status,401);assert.equal(groceryReads,0);
 const login=await fetch(origin+'/api/session',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({accessCode:account.accessCode})});
 const cookie=login.headers.get('set-cookie').split(';')[0];const r=await fetch(origin+'/api/groceries',{headers:{Cookie:cookie}});
 assert.equal(r.status,200);assert.equal((await r.json()).regionId,'krakow');assert.equal(groceryReads,1);assert.equal(f.calls(),0);
 const page=await fetch(origin+'/groceries');assert.equal(page.status,200);assert.match(await page.text(),/Your basket plan/);
});
