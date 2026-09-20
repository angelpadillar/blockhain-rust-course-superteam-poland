import test from 'node:test';
import assert from 'node:assert/strict';
import {registrationStructure,inspectRegistration,inspectRegistrationState} from './registration.mjs';
const snap=elements=>({url:'https://delio.com.pl/',elements});
const wrap=value=>({structuredContent:value});

test('field order and required metadata exclude all values, labels, names and private URLs',()=>{
  const result=registrationStructure(snap([{role:'button',name:'secret account name'}]),'<input type="tel" name="phone" required value="+48123456789"><input type="email" placeholder="secret@example.test" value="private@example.test"><input type="hidden" value="secret-token">');
  assert.deepEqual(result.observedFieldOrder,['phone','email']);
  assert.equal(result.fields[0].required,true);
  assert.equal(result.fieldsFilled,false);
  assert.equal(result.laterFieldOrderVerified,false);
  for(const s of ['secret','123456789','example.test','private'])assert.equal(JSON.stringify(result).includes(s),false);
});
test('OTP/terms observation does not imply request, acceptance or account creation',()=>{
  const r=registrationStructure(snap([{role:'heading',name:'Regulamin'},{role:'textbox',name:'Kod SMS'}]));
  assert.equal(r.otpFieldObserved,true);assert.equal(r.termsMentionObserved,true);
  assert.equal(r.otpRequested,false);assert.equal(r.termsAccepted,false);assert.equal(r.accountCreated,false);
});
test('foreign-origin and challenge pages stop before any action',async()=>{
  for(const snapshot of [{url:'https://other.test',elements:[]},snap([{role:'heading',name:'Verify you are human'}])]){
    const calls=[];
    await assert.rejects(inspectRegistration({check(){},remaining:()=>10000,client:{async call(name){calls.push(name);return wrap(snapshot);}}}));
    assert.deepEqual(calls,['browser_snapshot']);
  }
});
test('observed sign-in click inspects phone form without submit, fill, SMS or terms action',async()=>{
  const calls=[];
  let count=0;
  const result=await inspectRegistration({check(){},remaining:()=>10000,client:{async call(name,args){
    calls.push({name,args});
    if(name==='browser_snapshot')return wrap(count++===0?snap([{role:'button',name:'Zaloguj się',ref:'e1'}]):snap([{role:'button',name:'Zarejestruj się',ref:'e2'}]));
    if(name==='browser_get_content')return wrap({content:count===1?'<button>Zaloguj się</button>':'<input type="tel" required><button>Zarejestruj się</button>'});
    return wrap({});
  }}});
  assert.equal(result.phoneFieldObserved,true);
  assert.equal(result.navigationClicks,1);
  assert.equal(calls.filter(c=>c.name==='browser_click').length,1);
  assert.equal(calls.some(c=>/type|fill|eval|cookie/i.test(c.name)),false);
});
test('uncertain click stops without retry or second dispatch',async()=>{
  let clicks=0;
  await assert.rejects(inspectRegistration({check(){},remaining:()=>10000,client:{async call(name){
    if(name==='browser_snapshot')return wrap(snap([{role:'button',name:'Zaloguj się',ref:'e1'}]));
    if(name==='browser_get_content')return wrap({content:'<button>Zaloguj się</button>'});
    if(name==='browser_click'){clicks++;throw new Error('native timeout');}
    throw new Error('unexpected follow-up');
  }}}),/native timeout/);
  assert.equal(clicks,1);
});
test('duplicate observed sign-in copies require unique visible native matching, never an arbitrary index',async()=>{
  const calls=[];
  await assert.rejects(inspectRegistration({check(){},remaining:()=>10000,client:{async call(name,args){
    calls.push(name);
    if(name==='browser_click'){
      assert.equal(args.selector,'button:visible:text-is("Zaloguj się")');
      assert.equal(args.ref,undefined);
      throw new Error('ambiguous_selector');
    }
    return wrap(snap([{role:'button',name:'Zaloguj się',ref:'e1'},{role:'button',name:'Zaloguj się',ref:'e2'}]));
  }}}),/ambiguous_selector/);
  assert.deepEqual(calls,['browser_snapshot','browser_get_content','browser_click']);
});
test('already-open phone form is read directly without another sign-in click',async()=>{
  const calls=[];
  const result=await inspectRegistration({check(){},remaining:()=>10000,client:{async call(name){
    calls.push(name);
    if(name==='browser_snapshot')return wrap(snap([{role:'textbox',name:'Numer telefonu'}]));
    if(name==='browser_get_content')return wrap({content:'<input type="tel">'});
    throw new Error('unexpected action');
  }}});
  assert.equal(result.navigationClicks,0);
  assert.equal(result.phoneFieldObserved,true);
  assert.deepEqual(calls,['browser_snapshot','browser_get_content']);
});
test('one-time-code autocomplete takes precedence over tel and phone name',()=>{
  const result=registrationStructure(snap([]),'<input type="tel" name="phone" autocomplete="one-time-code" value="654321">');
  assert.equal(result.otpFieldObserved,true);
  assert.equal(result.phoneFieldObserved,false);
  assert.deepEqual(result.observedFieldOrder,['otp']);
  assert.equal(JSON.stringify(result).includes('654321'),false);
});
test('four numeric text controls need explicit rendered code/sent/resend context to classify as OTP',()=>{
  const inputs=Array.from({length:4},(_,i)=>`<input type="text" inputmode="numeric" value="${i+1}">`).join('');
  const context='<h1>Wpisz kod</h1><p>Kod został wysłany</p><button>Wyślij ponownie</button>';
  const result=registrationStructure(snap([]),context+inputs);
  assert.equal(result.otpFieldObserved,true);assert.equal(result.phoneFieldObserved,false);
  assert.equal(result.otpInputLayout,'four_numeric_fields');assert.deepEqual(result.observedFieldOrder,['otp']);
  assert.equal(result.fields.length,4);assert.equal(result.fields.every(field=>field.kind==='otp'),true);
  assert.equal(result.accountCreated,false);assert.equal(result.otpRequested,false);
  assert.equal(JSON.stringify(result).includes('value'),false);
  for(const html of [inputs,context.replace('Wpisz kod','Wpisz dane')+inputs,context+inputs+'<input type="email">','<script>'+context+'</script>'+inputs,context+inputs.replaceAll('inputmode="numeric"','')])assert.equal(registrationStructure(snap([]),html).otpFieldObserved,false);
});
test('segmented OTP already on the page never triggers sign-in or registration entry clicks',async()=>{
  const calls=[];
  const html='<p>Wpisz kod. Kod został wysłany.</p><button>Wyślij ponownie</button>'+('<input type="text" inputmode="numeric">'.repeat(4));
  const result=await inspectRegistration({check(){},remaining:()=>10000,client:{async call(name){
    calls.push(name);if(name==='browser_snapshot')return wrap(snap([{role:'button',name:'Zaloguj się',ref:'do-not-click'}]));
    if(name==='browser_get_content')return wrap({content:html});throw Error('No action allowed');
  }}});
  assert.equal(result.otpFieldObserved,true);assert.equal(result.navigationClicks,0);assert.deepEqual(calls,['browser_snapshot','browser_get_content']);
});
test('current registration inspection makes only reads and captures, even when OTP is unclassified',async()=>{
  const calls=[],captured=[];
  const result=await inspectRegistrationState({check(){},remaining:()=>10000,capturePrivate:async view=>{captured.push(view);return [{id:'private-hashed-evidence',private:true}];},client:{async call(name){
    calls.push(name);
    if(name==='browser_snapshot')return wrap(snap([{role:'button',name:'Zaloguj się',ref:'login'},{role:'textbox',name:''}]));
    if(name==='browser_get_content')return wrap({content:'<input type="text" value="private-value">'});
    throw new Error('Action forbidden in read-only inspection');
  }}});
  assert.deepEqual(calls,['browser_snapshot','browser_get_content']);
  assert.equal(captured.length,1);
  assert.equal(result.noActionsDispatched,true);
  assert.equal(result.navigationClicks,0);
  assert.equal(result.newAccountVerified,false);
  assert.equal(result.otpRequested,undefined);
  assert.equal(JSON.stringify(result).includes('private-value'),false);
});
