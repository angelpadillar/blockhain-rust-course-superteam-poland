import test from 'node:test';
import assert from 'node:assert/strict';
import {validateRequest,classifySnapshot,blocked,reviewedBrowserHosts} from './policy.mjs';
test('browser host configuration permits only exact observed map and auth dependencies',()=>{
  const config={initialUrl:'https://delio.com.pl/',allowedHosts:['delio.com.pl'],reviewedMapHosts:['maps.googleapis.com','maps.gstatic.com'],reviewedAuthHosts:['identitytoolkit.googleapis.com']};
  assert.deepEqual(reviewedBrowserHosts(config),['delio.com.pl','maps.googleapis.com','maps.gstatic.com','identitytoolkit.googleapis.com']);
  for(const host of ['*.googleapis.com','googleapis.com','securetoken.googleapis.com','identitytoolkit.googleapis.com.evil.test','https://identitytoolkit.googleapis.com'])assert.throws(()=>reviewedBrowserHosts({...config,reviewedAuthHosts:[host]}));
});
test('closed operation schema accepts only declared grounded inputs',()=>{
  for(const operation of ['status','observeCart','quote','inspectRegistration','inspectRegistrationState'])assert.equal(validateRequest({operation}).operation,operation);
  assert.ok(validateRequest({operation:'mutateCart',lines:[{productId:'A0000953',quantity:0}]}));
  for(const input of [{operation:'click',selector:'#buy'},{operation:'status',url:'https://other.test'},{operation:'status',lines:[]},{operation:'mutateCart'},{operation:'mutateCart',lines:[{productId:'A0000953',quantity:-1}]},{operation:'mutateCart',lines:[{productId:'A0000953',quantity:1},{productId:'A0000953',quantity:2}]}])assert.throws(()=>validateRequest(input));
});
test('registration inspection accepts no caller values, selector or phone',()=>{
  for(const input of [{operation:'inspectRegistration',lines:[]},{operation:'inspectRegistration',phone:'+48123456789'},{operation:'inspectRegistration',selector:'#submit'}])assert.throws(()=>validateRequest(input));
});
test('anonymous empty-cart text never verifies the owner cart or delivery',()=>{
  const result=classifySnapshot({url:'https://delio.com.pl/',elements:[{role:'button',name:'Zaloguj się'},{role:'button',name:'Podaj adres dostawy\n i rozpocznij zakupy'},{role:'button',name:'Twój koszyk, 0 produktów'}]});
  assert.equal(result.status,'blocked');assert.equal(result.blockers[0].code,'merchant_login_required');assert.ok(Object.values(result.capabilities).every(value=>value===false));assert.equal(result.observations.anonymousCartCounterObserved,true);
});
test('absence of login/address prompt is not proof; raw private text never escapes',()=>{
  const result=classifySnapshot({url:'https://delio.com.pl/',elements:[{role:'button',name:'SECRET_PERSON private street 123'},{role:'textbox',name:'OTP 123456'}]});
  assert.equal(result.blockers[0].code,'merchant_session_unverified');assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(JSON.stringify(result).includes('123456'),false);assert.ok(Object.values(result.capabilities).every(value=>value===false));
});
test('foreign pages and site challenges cannot establish access',()=>{
  assert.throws(()=>classifySnapshot({url:'https://attacker.test/',elements:[]}));
  const result=classifySnapshot({url:'https://delio.com.pl/',elements:[{role:'heading',name:'Verify you are human'}]});assert.equal(result.blockers[0].code,'merchant_challenge_required');
});
test('known no-dispatch failures are explicit',()=>{assert.deepEqual(blocked('worker_busy','Busy'),{ok:false,code:'worker_busy',dispatched:false,blockers:[{code:'worker_busy',message:'Busy'}]});});
