import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {phoneFormContract,publicPhoneContract,followupPhoneReadiness,startRegistration,startFollowupRegistration,startImportedRegistration,resumeRegistration,durableRegistrationWrite} from './registration-actions.mjs';
import {validateRequest} from './policy.mjs';
const PHONE='+48123456789';
const form=(value='',extra='')=>`<form><label>Numer telefonu *</label><input type="tel" maxlength="11" value="${value}"><button type="submit">Dalej</button>${extra}</form><p>Przechodząc dalej akceptujesz Regulamin serwisu, Regulamin sprzedaży napojów alkoholowych i Politykę Prywatności</p>`;
const wrap=value=>({structuredContent:value});
function fixture({failSubmit=false,persistFailure=false,existing=null,initialHtml=form(),expectedPhone=PHONE}={}){
  let html=initialHtml,intent=existing,revision=0;
  const calls=[],writes=[];
  const options={accountId:'delio-pilot-owner',phone:expectedPhone,bindingSecret:'x'.repeat(64),check(){},remaining:()=>20000,
    readIntent:async()=>intent,writeIntent:async(value)=>{if(persistFailure)throw new Error('disk full');intent=structuredClone(value);writes.push(intent);},
    capturePrivate:async()=>[{id:'private-test-artifact',observationSha256:'a'.repeat(64),screenshotSha256:'b'.repeat(64),private:true}],
    client:{async call(name,args){
      calls.push({name,args});
      if(name==='browser_snapshot')return wrap({url:'https://delio.com.pl/login',elements:[{role:'textbox',input_type:'tel',ref:`phone-${++revision}`,name:html.includes('tel')?'Numer telefonu':'Kod SMS'},{role:'button',name:'Dalej',ref:`next-${revision}`} ]});
      if(name==='browser_get_content')return wrap({content:html});
      if(name==='browser_type'){
        assert.equal(intent.stage,'phone_fill_pending');assert.equal(args.text,expectedPhone.slice(3));
        assert.equal(args.ref,`phone-${revision}`);assert.equal(args.selector,undefined);
        assert.equal(args.press_enter_after,false);html=form(args.text);return wrap({});
      }
      if(name==='browser_click'){
        assert.equal(intent.stage,'sms_submit_pending');assert.equal(intent.smsSubmitAttempted,true);
        assert.equal(args.ref,`next-${revision}`);assert.equal(args.selector,undefined);
        if(failSubmit)throw new Error('lost native reply');
        html='<input type="text" autocomplete="one-time-code">';return wrap({});
      }
      throw new Error('unexpected tool');
    }}};
  return {options,calls,writes,getIntent:()=>intent};
}
test('only the captured blank phone/continue/implicit-terms contract becomes ready',()=>{
  assert.equal(publicPhoneContract(form()).ready,true);
  for(const html of [form(PHONE.slice(3)),form('', '<input type="checkbox">'),form('', '<input type="email">'),form().replace('Dalej','Zapłać'),form().replace('Przechodząc dalej akceptujesz','')])assert.equal(publicPhoneContract(html).ready,false);
  assert.equal(phoneFormContract(form()).alcoholTermsMentionObserved,true);
  assert.equal(JSON.stringify(publicPhoneContract(form(PHONE.slice(3)))).includes(PHONE.slice(3)),false);
});
test('registration schema accepts no OTP/email/selector and requires full Polish E.164',()=>{
  for(const operation of ['startRegistration','resumeRegistration']){
    assert.equal(validateRequest({operation,accountId:'delio-pilot-owner',phone:PHONE}).phone,PHONE);
    for(const fields of [{phone:'123456789'},{email:'private@example.test'},{otp:'123456'},{selector:'#buy'}])assert.throws(()=>validateRequest({operation,accountId:'delio-pilot-owner',phone:PHONE,...fields}));
  }
});

function resumeFixture({blank=false,html:initialHtml,failSubmit=false,failWriteAt=0,intentPatch={}}={}){
  const bindingSecret='x'.repeat(64),now=1_000_000;
  let html=initialHtml??form(blank?'':PHONE.slice(3)),revision=0,writes=0;
  let intent={version:1,accountId:'delio-pilot-owner',phoneCommitment:createHmac('sha256',bindingSecret).update(PHONE).digest('hex'),
    createdAt:1,observedAt:now-60_000,stage:'needs_reconciliation',smsSubmitAttempted:true,
    followupCount:1,approvalId:'virtual53-test',history:[{intent:{stage:'needs_reconciliation',artifacts:[{id:'older-activation'}]}}],
    artifacts:[{id:'original-unknown',private:true}],...intentPatch};
  const original=structuredClone(intent),calls=[],journal=[];
  const options={accountId:'delio-pilot-owner',phone:PHONE,bindingSecret,now:()=>now,check(){},remaining:()=>20000,
    readIntent:async()=>intent,writeIntent:async value=>{if(++writes===failWriteAt)throw new Error('disk full');intent=structuredClone(value);journal.push(intent);},
    capturePrivate:async()=>[{id:`capture-${revision}`,private:true}],
    client:{async call(name,args){
      calls.push({name,args});
      if(name==='browser_snapshot')return wrap({url:'https://delio.com.pl/login',elements:[
        {role:'textbox',input_type:'tel',name:'Numer telefonu',ref:`phone-${++revision}`},
        {role:'button',name:'Dalej',ref:`next-${revision}`} ]});
      if(name==='browser_get_content')return wrap({content:html});
      if(name==='browser_type'){
        assert.equal(intent.resumeUsed,true);assert.equal(intent.submissionAttempts.length,1);
        assert.equal(args.ref,`phone-${revision}`);assert.equal(args.selector,undefined);
        assert.equal(args.text,PHONE.slice(3));assert.equal(args.press_enter_after,false);
        html=form(args.text);return wrap({});
      }
      if(name==='browser_click'){
        assert.equal(intent.stage,'sms_retry_pending');assert.equal(intent.submissionAttempts.length,2);
        assert.equal(intent.submissionAttempts[1].outcome,'pending');
        assert.equal(args.ref,`next-${revision}`);assert.equal(args.selector,undefined);
        if(failSubmit)throw Object.assign(new Error('native uncertain'),{browserFailure:{code:'native_timeout'}});
        html='<input type="tel" autocomplete="one-time-code">';return wrap({});
      }
      throw new Error('Unexpected native tool');
    }}};
  return {options,calls,journal,original,getIntent:()=>intent};
}
test('one same-phone recovery uses a fresh native ref, preserves original unknown and durably records submit two',async()=>{
  const f=resumeFixture();const result=await resumeRegistration(f.options);
  assert.equal(result.otpFieldObserved,true);assert.equal(result.totalSubmitAttempts,2);
  assert.equal(result.accountCreated,false);assert.equal(result.newAccountVerified,false);
  assert.equal(f.calls.filter(c=>c.name==='browser_type').length,0);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
  const intent=f.getIntent();assert.deepEqual(intent.priorUnknown.artifacts,f.original.artifacts);
  assert.equal(intent.priorUnknown.stage,'needs_reconciliation');assert.equal(intent.submissionAttempts[0].outcome,'unknown');
  assert.equal(JSON.stringify([result,f.journal]).includes(PHONE),false);
  assert.equal(JSON.stringify([result,f.journal]).includes(PHONE.slice(3)),false);
  await assert.rejects(resumeRegistration(f.options),/resume_not_permitted/);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('a blank form refills the same bound phone once through its observed native ref',async()=>{
  const f=resumeFixture({blank:true});const result=await resumeRegistration(f.options);
  assert.equal(result.otpFieldObserved,true);assert.equal(f.calls.filter(c=>c.name==='browser_type').length,1);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('after source reload, recovery opens only observed anonymous sign-in then refills same bound phone',async()=>{
  const f=resumeFixture({blank:true}),native=f.options.client.call;let entered=false,entryClicks=0;
  f.options.client.call=async(name,args)=>{
    if(!entered){
      if(name==='browser_snapshot')return wrap({url:'https://delio.com.pl/',elements:[{role:'button',name:'Zaloguj się',ref:'observed-login'},{role:'textbox',input_type:'text',name:'Szukaj'}]});
      if(name==='browser_get_content')return wrap({content:'<input type="text" placeholder="Szukaj"><button>Zaloguj się</button>'});
      if(name==='browser_click'){assert.equal(args.ref,'observed-login');entered=true;entryClicks++;return wrap({});}
      throw Error('Unexpected homepage action');
    }
    return native(name,args);
  };
  assert.equal((await resumeRegistration(f.options)).totalSubmitAttempts,2);
  assert.equal(entryClicks,1);assert.equal(f.calls.filter(c=>c.name==='browser_type').length,1);assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('binding, cooldown and consumed retry gates stop before browser calls',async()=>{
  for(const intentPatch of [{accountId:'other-owner'},{phoneCommitment:'f'.repeat(64)},{observedAt:999_999},{resumeUsed:true},
    {submissionAttempts:[{attempt:1},{attempt:2}]},{smsSubmitAttempted:false},{stage:'registered'},{followupCount:0},{approvalId:'other'}]){
    const f=resumeFixture({intentPatch});await assert.rejects(resumeRegistration(f.options));assert.equal(f.calls.length,0);assert.equal(f.journal.length,0);
  }
});
test('Virtual53 native-returned first outcome and older activation audit survive one recovery',async()=>{
  const first={attempt:1,outcome:'native_returned',recordedAt:1};
  const f=resumeFixture({intentPatch:{stage:'phone_submit_returned',submissionAttempts:[first]}});
  const result=await resumeRegistration(f.options);
  assert.equal(result.totalSubmitAttempts,2);
  assert.deepEqual(f.getIntent().submissionAttempts[0],first);
  assert.deepEqual(f.getIntent().priorUnknown.submissionAttempts,[first]);
  assert.equal(f.getIntent().priorUnknown.stage,'phone_submit_returned');
  assert.equal(f.getIntent().priorUnknown.merchantSmsOutcomeVerified,false);
  assert.deepEqual(f.getIntent().history,f.original.history);
});
test('only the specifically imported order gets one corrective same-phone recovery with all history intact',async()=>{
  const patch={followupCount:undefined,importedActivation:true,importedActivationCount:1,activationOrderId:'1094850855',approvalId:'user-order-1094850855',stage:'phone_submit_returned',submissionAttempts:[{attempt:1,outcome:'native_returned',recordedAt:1}]};
  const f=resumeFixture({intentPatch:patch});assert.equal((await resumeRegistration(f.options)).totalSubmitAttempts,2);
  assert.deepEqual(f.getIntent().history,f.original.history);assert.deepEqual(f.getIntent().submissionAttempts[0],patch.submissionAttempts[0]);
  await assert.rejects(resumeRegistration(f.options),/resume_not_permitted/);assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
  for(const wrong of [{activationOrderId:'another-order'},{approvalId:'different-approval'},{importedActivationCount:2}]){
    const rejected=resumeFixture({intentPatch:{...patch,...wrong}});await assert.rejects(resumeRegistration(rejected.options),/resume_not_permitted/);assert.equal(rejected.calls.length,0);
  }
});
test('active invalid states and rendered challenges block recovery but conditional CSS does not',async()=>{
  for(const html of [form().replace('type="tel"','type="tel" aria-invalid="true"'),form().replace('type="tel"','type="tel" data-invalid="true"'),form().replace('type="tel"','type="tel" class="is-invalid"'),form().replace('type="tel"','type="tel" readonly'),form()+'<p>Verify you are human</p>']){
    const f=resumeFixture({html});await assert.rejects(resumeRegistration(f.options));
    assert.equal(f.calls.some(c=>['browser_type','browser_click'].includes(c.name)),false);assert.equal(f.journal.length,0);
  }
  const f=resumeFixture({html:form(PHONE.slice(3)).replace('type="tel"','type="tel" class="aria-invalid:border-error-500 focus:invalid:border-red-500"')});
  assert.equal((await resumeRegistration(f.options)).totalSubmitAttempts,2);
});
test('changed phone, OTP or disabled submit cannot trigger any input or submit',async()=>{
  for(const html of [form('987654321'),'<input type="tel" autocomplete="one-time-code">',form().replace('type="submit"','type="submit" disabled'),form().replace('type="submit"','type="submit" aria-disabled="true"')]){
    const f=resumeFixture({html});await assert.rejects(resumeRegistration(f.options));
    assert.equal(f.calls.some(c=>['browser_type','browser_click'].includes(c.name)),false);assert.equal(f.journal.length,0);
  }
});
test('second native uncertainty is terminal for resume and captures failure privately',async()=>{
  const f=resumeFixture({failSubmit:true});const result=await resumeRegistration(f.options);
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.totalSubmitAttempts,2);
  assert.equal(f.getIntent().submissionAttempts[1].outcome,'unknown');assert.deepEqual(f.getIntent().nativeFailure,{code:'native_timeout'});
  await assert.rejects(resumeRegistration(f.options),/resume_not_permitted/);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('durable failure before retry dispatch never clicks, and an earlier reservation prevents reuse',async()=>{
  for(const failWriteAt of [1,2]){
    const f=resumeFixture({failWriteAt});
    if(failWriteAt===1)await assert.rejects(resumeRegistration(f.options),/disk full/);
    else {const result=await resumeRegistration(f.options);assert.equal(result.status,'needs_reconciliation');await assert.rejects(resumeRegistration(f.options),/resume_not_permitted/);}
    assert.equal(f.calls.some(c=>c.name==='browser_click'),false);
  }
});
test('one phone fill and one SMS submit are each preceded by durable intent; public output contains no phone',async()=>{
  const f=fixture();const result=await startRegistration(f.options);
  assert.equal(result.status,'phone_submit_returned');assert.equal(result.otpFieldObserved,true);
  assert.equal(result.accountCreated,false);assert.equal(result.marketingSelected,false);
  assert.equal(f.calls.filter(c=>c.name==='browser_type').length,1);assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
  assert.equal(JSON.stringify([result,f.writes]).includes(PHONE),false);assert.equal(JSON.stringify([result,f.writes]).includes(PHONE.slice(3)),false);
  await assert.rejects(startRegistration(f.options),/registration_intent_exists_reconcile_required/);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('uncertain submit never retries or claims an account and retains the one-use reservation',async()=>{
  const f=fixture({failSubmit:true});const result=await startRegistration(f.options);
  assert.equal(result.status,'needs_reconciliation');assert.equal(result.smsSubmitAttempted,true);
  assert.equal(result.accountCreated,false);assert.equal(f.getIntent().stage,'needs_reconciliation');
  await assert.rejects(startRegistration(f.options),/reconcile_required/);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('journal failure before private input prevents all fill and submit actions',async()=>{
  const f=fixture({persistFailure:true});await assert.rejects(startRegistration(f.options));
  assert.equal(f.calls.some(c=>['browser_type','browser_click'].includes(c.name)),false);
});
test('durable journal initial create is exclusive across restarts and updates preserve the record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'delio-registration-'));
  try{
    await durableRegistrationWrite(root,{stage:'pending'},{initial:true});
    await assert.rejects(durableRegistrationWrite(root,{stage:'overwrite'},{initial:true}),/EEXIST/);
    await durableRegistrationWrite(root,{stage:'needs_reconciliation'});
    assert.deepEqual(JSON.parse(await readFile(join(root,'registration-intent.json'),'utf8')),{stage:'needs_reconciliation'});
  }finally{await rm(root,{recursive:true,force:true});}
});

const NEXT_PHONE='+48987654321';
const oldIntent=()=>({version:1,accountId:'delio-pilot-owner',phoneCommitment:createHmac('sha256','x'.repeat(64)).update(PHONE).digest('hex'),
  createdAt:1,observedAt:2,stage:'needs_reconciliation',smsSubmitAttempted:true,artifacts:[{id:'old-unknown',private:true}],nativeFailure:null});
const followupOptions=f=>({...f.options,previousPhone:PHONE,previousActivationStatus:'TIMEOUT',approvalId:'virtual53-test'});
test('separate follow-up readiness allows only blank or old bound phone and leaves initial empty requirement intact',()=>{
  const context={snapshot:{url:'https://delio.com.pl/',elements:[]},intent:oldIntent(),bindingSecret:'x'.repeat(64)};
  for(const html of [form(),form(PHONE.slice(3))])assert.deepEqual(followupPhoneReadiness({...context,html}),{followupSubmissionReady:true,registrationIntentAccountId:'delio-pilot-owner',requiresProviderTimeoutConfirmation:true});
  assert.equal(publicPhoneContract(form(PHONE.slice(3))).ready,false);
  for(const html of [form('111111111'),'<input type="tel" autocomplete="one-time-code">','<input type="search">'])assert.equal(followupPhoneReadiness({...context,html}).followupSubmissionReady,false);
  assert.equal(followupPhoneReadiness({...context,html:form(),intent:{...oldIntent(),followupCount:1}}).followupSubmissionReady,false);
  assert.equal(followupPhoneReadiness({...context,html:form(),snapshot:{url:'https://delio.com.pl/',elements:[{role:'button',name:'Wyloguj się'}]}}).followupSubmissionReady,false);
});
test('follow-up schema requires exact approval, previous terminal status and different Polish phone',()=>{
  const valid={operation:'startFollowupRegistration',accountId:'delio-pilot-owner',phone:NEXT_PHONE,previousPhone:PHONE,previousActivationStatus:'TIMEOUT',approvalId:'virtual53-test'};
  assert.deepEqual(validateRequest(valid),valid);
  for(const patch of [{phone:PHONE},{previousPhone:'private'},{previousActivationStatus:'PENDING'},{approvalId:'other'},{email:'private@example.test'},{otp:'123456'}])assert.throws(()=>validateRequest({...valid,...patch}));
});
test('one authorized different-phone follow-up retains the complete old audit before native fill and submit',async()=>{
  for(const initialHtml of [form(),form(PHONE.slice(3))]){
    const original=oldIntent();const f=fixture({existing:original,initialHtml,expectedPhone:NEXT_PHONE});
    const result=await startFollowupRegistration(followupOptions(f));
    assert.equal(result.status,'phone_submit_returned');assert.equal(result.otpFieldObserved,true);
    assert.equal(result.previousIntentPreserved,true);assert.equal(result.approvalId,'virtual53-test');assert.equal(result.newAccountVerified,false);
    for(const written of f.writes){assert.deepEqual(written.history[0].intent,original);assert.equal(written.followupCount,1);}
    assert.equal(f.getIntent().submissionAttempts.length,1);
    assert.equal(f.calls.filter(c=>c.name==='browser_type').length,1);assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
    assert.equal(JSON.stringify([result,f.writes]).includes(PHONE.slice(3)),false);assert.equal(JSON.stringify([result,f.writes]).includes(NEXT_PHONE.slice(3)),false);
    await assert.rejects(startFollowupRegistration({...followupOptions(f),previousPhone:NEXT_PHONE,phone:PHONE}),/followup_not_permitted/);
    assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
  }
});
test('follow-up refuses wrong prior binding, consumed allowance and unsupported prior outcomes before observation',async()=>{
  for(const patch of [{accountId:'another-owner'},{phoneCommitment:'f'.repeat(64)},{followupCount:1},{approvalId:'virtual53-test'},
    {history:[{}]},{smsSubmitAttempted:false},{stage:'phone_submit_returned'}]){
    const f=fixture({existing:{...oldIntent(),...patch},expectedPhone:NEXT_PHONE});
    await assert.rejects(startFollowupRegistration(followupOptions(f)));assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  }
});
test('follow-up refuses an unrelated filled phone or an OTP view without replacing the original audit',async()=>{
  for(const initialHtml of [form('111111111'),'<input type="tel" autocomplete="one-time-code">']){
    const original=oldIntent(),f=fixture({existing:original,initialHtml,expectedPhone:NEXT_PHONE});
    await assert.rejects(startFollowupRegistration(followupOptions(f)));
    assert.deepEqual(f.getIntent(),original);assert.equal(f.writes.length,0);
    assert.equal(f.calls.some(c=>['browser_type','browser_click'].includes(c.name)),false);
  }
});
test('follow-up uncertain click is not repeated and preserves both attempt histories',async()=>{
  const original=oldIntent(),f=fixture({existing:original,expectedPhone:NEXT_PHONE,failSubmit:true});
  const result=await startFollowupRegistration(followupOptions(f));
  assert.equal(result.status,'needs_reconciliation');assert.equal(f.getIntent().submissionAttempts[0].outcome,'unknown');
  assert.deepEqual(f.getIntent().history[0].intent,original);
  await assert.rejects(startFollowupRegistration({...followupOptions(f),previousPhone:NEXT_PHONE,phone:PHONE}),/followup_not_permitted/);
  assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
});
test('failed durable follow-up reservation never fills or overwrites the prior audit',async()=>{
  const original=oldIntent(),f=fixture({existing:original,expectedPhone:NEXT_PHONE,persistFailure:true});
  await assert.rejects(startFollowupRegistration(followupOptions(f)),/disk full/);
  assert.deepEqual(f.getIntent(),original);assert.equal(f.calls.some(c=>['browser_type','browser_click'].includes(c.name)),false);
});

const importedOptions=f=>({...f.options,activationOrderId:'1094850855',approvalId:'user-order-1094850855'});
const twoAttemptHistory=()=>({...oldIntent(),stage:'phone_submit_returned',followupCount:1,approvalId:'virtual53-test',history:[{intent:{stage:'needs_reconciliation',artifacts:[{id:'first-attempt'}]}}]});
test('imported activation schema permits only explicitly approved order and no extra customer identity',()=>{
  const valid={operation:'startImportedRegistration',accountId:'delio-pilot-owner',phone:NEXT_PHONE,activationOrderId:'1094850855',approvalId:'user-order-1094850855'};
  assert.deepEqual(validateRequest(valid),valid);
  for(const patch of [{activationOrderId:'another-order'},{approvalId:'other'},{email:'private@example.test'},{previousPhone:PHONE}])assert.throws(()=>validateRequest({...valid,...patch}));
});
test('imported owned activation preserves both prior attempts and uses one native new-phone submit',async()=>{
  for(const initialHtml of [form(),form(PHONE.slice(3))]){
    const original=twoAttemptHistory(),f=fixture({existing:original,initialHtml,expectedPhone:NEXT_PHONE});
    const result=await startImportedRegistration(importedOptions(f));
    assert.equal(result.importedActivation,true);assert.equal(result.previousIntentPreserved,true);assert.equal(result.accountCreated,false);
    for(const written of f.writes){assert.deepEqual(written.history[0].intent,original);assert.equal(written.activationOrderId,'1094850855');}
    assert.equal(f.getIntent().submissionAttempts.length,1);assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
    await assert.rejects(startImportedRegistration(importedOptions(f)),/import_not_permitted/);
    assert.equal(f.calls.filter(c=>c.name==='browser_click').length,1);
  }
});
test('import refuses wrong account, reused order, already-bound phone or unapproved order before browser actions',async()=>{
  for(const {patch={},request={}} of [{patch:{accountId:'another-owner'}},{patch:{importedActivation:true}},{request:{phone:PHONE}},{request:{approvalId:'another-order'}},{patch:{stage:'registered'}}]){
    const f=fixture({existing:{...twoAttemptHistory(),...patch},expectedPhone:NEXT_PHONE});
    await assert.rejects(startImportedRegistration({...importedOptions(f),...request}));assert.equal(f.calls.length,0);assert.equal(f.writes.length,0);
  }
});
test('import refuses unrelated existing phone and retains old audit if reservation fails',async()=>{
  for(const {initialHtml,persistFailure} of [{initialHtml:form('111111111')},{initialHtml:form(),persistFailure:true}]){
    const original=twoAttemptHistory(),f=fixture({existing:original,initialHtml,persistFailure,expectedPhone:NEXT_PHONE});
    await assert.rejects(startImportedRegistration(importedOptions(f)));assert.deepEqual(f.getIntent(),original);
    assert.equal(f.calls.some(c=>['browser_type','browser_click'].includes(c.name)),false);
  }
});
