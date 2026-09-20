import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUrl, isSafeControl, shoppingActions, shoppingRequest, summarizeShopping, executeShoppingAction, checkoutReady } from './shopping-benchmark.mjs';
import { verifyShoppingEvidence } from './shopping-evidence.mjs';
const url='https://glovoapp.com/pl/pl/krakow';
const control=label=>({tag:'button',label,testid:'',href:'',context:'',index:0});
const config={items:[{query:'Hortex Tropical Duo',qty:1}],max_pln:26,address_line:'Example Street 20, Kraków',phone:'123456789',contact_email:'private@example.test'};
test('purchase, payment, subscription and account controls are excluded',()=>{
  for(const label of ['Order and pay','Place order','Confirm order','Zapłać','Zamów','Zamawiam','Kup teraz','Dodaj kartę','Metoda płatności','Subscribe','Zaloguj się','Wyloguj']) assert.equal(isSafeControl(control(label),url),false,label);
  for(const label of ['Dodaj do koszyka','Przejdź do kasy','Wyszukaj']) assert.equal(isSafeControl(control(label),url),true,label);
});
test('domain guard rejects payment destinations and deceptive hosts',()=>{
  for(const u of ['https://glovoapp.com.attacker.test/pl/pl/krakow','https://glovoapp.com/pl/profile','http://glovoapp.com/pl/pl/krakow','https://glovoapp.com/pl/pl/krakow/payment']) assert.equal(allowedUrl(u),false,u);
  assert.equal(allowedUrl(url+'/stores/observed-store'),true);
});
test('checkout is read only even if a purchase button has an unfamiliar label',()=>{
  assert.deepEqual(shoppingActions({url:url+'/checkout',controls:[control('Continue')]},config),[]);
});
test('a filled cart cannot claim checkout completion and a loading checkout is not ready',()=>{
  for(const observation of [{url,snapshot:'Twoje zamówienie 3 produkty ŁĄCZNIE 25,24 zł'},{url:url+'/order-summary',snapshot:'Loading'}]) {
    assert.equal(checkoutReady(observation),false);
    assert.ok(!Object.hasOwn(shoppingRequest(config,observation,[],[]).questions.next_action.criteria,'done'));
  }
  const observation={url:url+'/order-summary',snapshot:'Podsumowanie zamówienia ŁĄCZNIE 25,24 zł Zamów i zapłać'};
  assert.equal(checkoutReady(observation),true);
  assert.ok(Object.hasOwn(shoppingRequest(config,observation,[],[]).questions.next_action.criteria,'done'));
});
test('personal form fields are not filled and personal data is redacted before API submission',()=>{
  const observation={url,snapshot:'Example Street 20, Kraków private@example.test 123456789',controls:[{...control('Phone'),tag:'input',type:'tel'}]};
  assert.deepEqual(shoppingActions(observation,config),[]);
  const request=JSON.stringify(shoppingRequest(config,observation,[],[]));
  for(const privateValue of [config.address_line,config.phone,config.contact_email]) assert.ok(!request.includes(privateValue));
});
test('execution rechecks the no-payment guard even for a forged candidate',async()=>{
  await assert.rejects(executeShoppingAction({url:async()=>url},{url},{kind:'click',control:control('Order and pay')}),/Unsafe/);
  await assert.rejects(executeShoppingAction({}, {url:url+'/order-summary'}, {kind:'click',control:control('Continue')}),/read only/);
});
test('model cost and browser time remain distinct and Codex cost stays unknown',()=>{
  const run={provider:'jev',label:'x',startedAt:'2026-09-16T10:00:00Z',updatedAt:'2026-09-16T10:00:10Z',steps:[{observationMs:100,decisionMs:450,executionMs:900,outcome:'executed',response:{latencyMs:400,usage:{input_tokens:10000,output_tokens:1000}}}]};
  const s=summarizeShopping(run);
  assert.equal(s.estimatedModelUsd,0.00042);assert.equal(s.activeMs,1450);assert.equal(s.wallMs,10000);
  assert.equal(summarizeShopping({...run,provider:'codex'}).estimatedModelUsd,null);
});
test('independent verification rejects missing checkout, wrong quantity and excess cost despite a done claim',()=>{
  const run={stopped:'done',steps:[{after:'heading "Twoje zamówienie"\n- paragraph: 1 produkt\n- paragraph: Test drink\n- status:\n  - generic: "1"'}],
    finalSnapshot:'heading "Podsumowanie zamówienia"\n- paragraph: "1 prod. z: Test shop"\n- paragraph: ŁĄCZNIE\n- paragraph: 5,00 zł\n- button "Zamów i zapłać"'};
  assert.equal(verifyShoppingEvidence(run,[{query:'Test drink',qty:1}],10).passed,true);
  assert.equal(verifyShoppingEvidence({...run,finalSnapshot:''},[{query:'Test drink',qty:1}],10).passed,false);
  assert.equal(verifyShoppingEvidence(run,[{query:'Test drink',qty:2}],10).passed,false);
  assert.equal(verifyShoppingEvidence(run,[{query:'Test drink',qty:1}],4).passed,false);
});
