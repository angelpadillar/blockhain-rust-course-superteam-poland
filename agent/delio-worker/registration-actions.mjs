import { readFile, open, rename } from 'node:fs/promises';
import { createHmac, createHash } from 'node:crypto';
import { structured } from './vendor/mcp.mjs';
import { inspectRegistration, registrationStructure } from './registration.mjs';
import { WorkerError, SESSION_ID } from './policy.mjs';

const attributes = source => Object.fromEntries([...source.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)]
  .map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
const stripScripts = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

/** This contract is grounded in the captured blank Delio sign-in page. */
export function phoneFormContract(html) {
  html = stripScripts(String(html || ''));
  const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/gi)];
  const telSources = [...html.matchAll(/<input\b([^>]*)>/gi)].filter(m=>attributes(m[1]).type==='tel');
  const telInputs = telSources.map(m=>attributes(m[1]));
  const phoneEditable=telSources.length===1&&!/(?:^|\s)(?:disabled|readonly)(?:\s|=|$)/i.test(telSources[0][1]);
  const input=telInputs[0]||{},classes=String(input.class||'').split(/\s+/);
  const invalidPhoneObserved=input['aria-invalid']==='true'||input['data-invalid']==='true'||input['data-state']==='invalid'||classes.some(c=>/^(?:error|invalid|is-invalid|is-error|border-(?:red|error)(?:-\d+)?)$/.test(c));
  const userInputs = [...html.matchAll(/<input\b([^>]*)>/gi)].map(m => attributes(m[1]))
    .filter(a => !['hidden','submit','button','checkbox','radio'].includes(a.type));
  const phoneForms = forms.filter(m => /<input\b[^>]*\btype=["']tel["']/i.test(m[1]));
  const form = phoneForms.length === 1 ? phoneForms[0][1] : '';
  const submits = [...form.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)]
    .filter(m => attributes(m[1]).type === 'submit' && text(m[2]) === 'Dalej');
  const submitEnabled = submits.length === 1 && !/(?:^|\s)disabled(?:\s|=|$)/i.test(submits[0][1]) && attributes(submits[0][1])['aria-disabled'] !== 'true';
  const checkboxes = [...html.matchAll(/<(?:input|button|div|span)\b([^>]*)>/gi)]
    .filter(m => { const a = attributes(m[1]); return a.type === 'checkbox' || a.role === 'checkbox'; });
  const plain = text(html);
  const implicitTerms = /Przechodząc dalej akceptujesz/.test(plain) && /Regulamin serwisu/.test(plain) && /Politykę Prywatności/.test(plain);
  const phoneRequiredLabel = /Numer telefonu\s*\*/.test(text(form));
  return { phoneCount: telInputs.length, phoneFormCount: phoneForms.length, submitCount: submits.length,
    maxLength: telInputs[0]?.maxlength === '11' ? 11 : null, phoneRequiredLabel,
    checkboxCount: checkboxes.length, submitEnabled, phoneEditable, invalidPhoneObserved, implicitTermsObserved: implicitTerms, marketingSelected: false,
    alcoholTermsMentionObserved: /Regulamin sprzedaży napojów alkoholowych/.test(plain),
    ready: telInputs.length === 1 && userInputs.length === 1 && phoneForms.length === 1 && submits.length === 1 && telInputs[0].maxlength === '11'
      && submitEnabled && phoneEditable && !invalidPhoneObserved && phoneRequiredLabel && implicitTerms && checkboxes.length === 0,
    // Private internal comparison only; this field never enters a public reply.
    currentDigits: (telInputs[0]?.value || '').replace(/\D/g, '') };
}
export function publicPhoneContract(html) {
  const { currentDigits, ...safe } = phoneFormContract(html);
  return {...safe,ready:safe.ready&&currentDigits.length===0,phoneEntryEmpty:currentDigits.length===0};
}

/** Read-only follow-up readiness; the controller still verifies provider TIMEOUT. */
export function followupPhoneReadiness({snapshot,html,intent,bindingSecret}) {
  const notReady={followupSubmissionReady:false,registrationIntentAccountId:null};
  if(!intent||!/^[a-z][a-z0-9_-]{1,63}$/.test(intent.accountId||'')||intent.stage!=='needs_reconciliation'||intent.smsSubmitAttempted!==true||intent.followupCount||intent.approvalId||intent.history?.length||typeof bindingSecret!=='string'||bindingSecret.length<32)return notReady;
  const observed=registrationStructure(snapshot,html),contract=phoneFormContract(html);
  const accountControls=(snapshot.elements||[]).some(e=>['button','link','heading'].includes(e.role)&&/^(?:Moje konto|Wyloguj(?: się)?|Moje zamówienia)$/i.test(String(e.name||'').trim()));
  if(!contract.ready||observed.otpFieldObserved||observed.emailFieldObserved||observed.passwordFieldObserved||accountControls)return notReady;
  if(contract.currentDigits&&createHmac('sha256',bindingSecret).update('+48'+contract.currentDigits).digest('hex')!==intent.phoneCommitment)return notReady;
  return {followupSubmissionReady:true,registrationIntentAccountId:intent.accountId,requiresProviderTimeoutConfirmation:true};
}

export async function durableRegistrationWrite(root, value, { initial = false } = {}) {
  const target = `${root}/registration-intent.json`, pending = initial ? target : `${target}.tmp`;
  const file = await open(pending, initial ? 'wx' : 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  if (!initial) await rename(pending, target);
  const directory = await open(root, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}

export async function startRegistration(options) { return runPhoneStart(options); }

export async function startFollowupRegistration(options) {
  return runPhoneStart({...options,followup:true});
}

export async function startImportedRegistration(options) {
  return runPhoneStart({...options,imported:true});
}

async function runPhoneStart({ client, check, remaining, capturePrivate, accountId, phone,
  followup=false,imported=false,previousPhone,previousActivationStatus,approvalId,activationOrderId,
  root, bindingSecret, readIntent = async () => {
    try { return JSON.parse(await readFile(`${root}/registration-intent.json`, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }, writeIntent = (value, options) => durableRegistrationWrite(root, value, options) }) {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(accountId || '') || !/^\+48\d{9}$/.test(phone || '')) throw new WorkerError('invalid_registration_input');
  if (typeof bindingSecret !== 'string' || bindingSecret.length < 32) throw new WorkerError('registration_binding_unavailable');
  const prior = await readIntent();
  if(imported){
    if(approvalId!=='user-order-1094850855'||activationOrderId!=='1094850855')throw new WorkerError('registration_import_not_authorized');
    if(!prior||prior.accountId!==accountId)throw new WorkerError('registration_binding_mismatch');
    if(!['needs_reconciliation','phone_submit_returned'].includes(prior.stage)||prior.smsSubmitAttempted!==true||prior.importedActivation||prior.activationOrderId||prior.approvalId===approvalId)throw new WorkerError('registration_import_not_permitted');
    if(prior.phoneCommitment===createHmac('sha256',bindingSecret).update(phone).digest('hex'))throw new WorkerError('registration_import_phone_already_bound');
  }else if(followup){
    if(previousActivationStatus!=='TIMEOUT'||approvalId!=='virtual53-test'||!/^\+48\d{9}$/.test(previousPhone||'')||previousPhone===phone)throw new WorkerError('registration_followup_not_authorized');
    const oldCommitment=createHmac('sha256',bindingSecret).update(previousPhone).digest('hex');
    if(!prior||prior.accountId!==accountId||prior.phoneCommitment!==oldCommitment)throw new WorkerError('registration_binding_mismatch');
    if(prior.stage!=='needs_reconciliation'||prior.smsSubmitAttempted!==true||prior.followupCount||prior.approvalId||prior.history?.length)throw new WorkerError('registration_followup_not_permitted');
  }else if(prior)throw new WorkerError('registration_intent_exists_reconcile_required');
  const call = async (name, args) => {
    check();
    const r = await client.call(name, { session_id: SESSION_ID, ...args }, { timeoutMs: Math.max(1, Math.min(5000, remaining())) });
    check(); return structured(r);
  };
  const readView = async () => {
    const snapshot = await call('browser_snapshot', { max_elements: 1000, interactive_only: true });
    registrationStructure(snapshot); // Same-origin/challenge gate before each action.
    const raw = await call('browser_get_content', { format: 'html', max_bytes: 524288 });
    const html = typeof raw.content === 'string' ? raw.content : typeof raw.html === 'string' ? raw.html : typeof raw.text === 'string' ? raw.text : '';
    return { snapshot, html };
  };
  const checkPhoneView = view => {
    const observed=registrationStructure(view.snapshot,view.html);
    const accountControls=(view.snapshot.elements||[]).some(e=>['button','link','heading'].includes(e.role)&&/^(?:Moje konto|Wyloguj(?: się)?|Moje zamówienia)$/i.test(String(e.name||'').trim()));
    if(observed.otpFieldObserved||observed.emailFieldObserved||observed.passwordFieldObserved||accountControls)throw new WorkerError('registration_view_changed');
    const contract=phoneFormContract(view.html);
    if(!contract.ready)throw new WorkerError('registration_phone_controls_unverified');
    return contract;
  };
  // This navigates only if the phone entry is not already open.
  await inspectRegistration({ client, check, remaining });
  let before = await readView();
  const contract = checkPhoneView(before);
  const allowedPriorDigits=followup?previousPhone.slice(3):'';
  const allowedCurrentDigits=digits=>!digits||(imported?createHmac('sha256',bindingSecret).update('+48'+digits).digest('hex')===prior.phoneCommitment:digits===allowedPriorDigits);
  if (!allowedCurrentDigits(contract.currentDigits)) throw new WorkerError('registration_phone_controls_unverified');
  if (remaining() < 8000) throw new WorkerError('registration_deadline_before_input');
  const artifacts = await capturePrivate(before);
  let intent = { version: 1, accountId, phoneCommitment: createHmac('sha256', bindingSecret).update(phone).digest('hex'),
    createdAt: Date.now(), stage: 'phone_fill_pending', artifacts, smsSubmitAttempted: false,
    ...(followup||imported?{approvalId,history:[{sha256:createHash('sha256').update(JSON.stringify(prior)).digest('hex'),intent:structuredClone(prior)}]}:{}),
    ...(followup?{followupCount:1,previousActivationStatus}:{}),
    ...(imported?{importedActivation:true,activationOrderId,importedActivationCount:1}: {}) };
  await writeIntent(intent, { initial: !(followup||imported) }); // Atomic replacement retains the entire prior audit before input.
  let submitAttempted = false;
  try {
    before=await readView();
    const fresh=checkPhoneView(before);
    if(!allowedCurrentDigits(fresh.currentDigits))throw new WorkerError('registration_phone_value_unverified');
    const inputs=(before.snapshot.elements||[]).filter(e=>e.role==='textbox'&&e.input_type==='tel'&&typeof e.ref==='string');
    if(inputs.length!==1)throw new WorkerError('registration_phone_ref_unverified');
    await call('browser_type', { ref:inputs[0].ref, text: phone.slice(3), clear_first: true,
      press_enter_after: false, timeout_ms: Math.max(1, Math.min(4000, remaining())) });
    const filled = await readView();
    const current = checkPhoneView(filled);
    if (!current.ready || current.currentDigits !== phone.slice(3)) throw new WorkerError('registration_phone_value_unverified');
    if (remaining() < 4000) throw new WorkerError('registration_deadline_before_submit');
    const filledEvidence = await capturePrivate(filled);
    const submitView=await readView(),submitContract=checkPhoneView(submitView);
    const buttons=(submitView.snapshot.elements||[]).filter(e=>e.role==='button'&&String(e.name||'').trim()==='Dalej'&&typeof e.ref==='string');
    if(submitContract.currentDigits!==phone.slice(3)||buttons.length!==1)throw new WorkerError('registration_submit_ref_unverified');
    intent = { ...intent, stage: 'sms_submit_pending', artifacts: [...artifacts, ...filledEvidence], smsSubmitAttempted: true,
      submissionAttempts:[{attempt:1,outcome:'pending',recordedAt:Date.now()}] };
    await writeIntent(intent);
    submitAttempted = true;
    await call('browser_click', { ref:buttons[0].ref,
      timeout_ms: Math.max(1, Math.min(4000, remaining())) });
    let after,observed;
    for(let scan=0;scan<5;scan++){
      after=await readView();observed=registrationStructure(after.snapshot,after.html);
      if(observed.otpFieldObserved||observed.emailFieldObserved||!observed.phoneFieldObserved||scan===4||remaining()<1500)break;
      await new Promise(resolve=>setTimeout(resolve,200));check();
    }
    const afterEvidence = await capturePrivate(after);
    intent = { ...intent, stage: 'phone_submit_returned', observedAt: Date.now(), artifacts: [...intent.artifacts, ...afterEvidence],
      submissionAttempts:[{...intent.submissionAttempts[0],outcome:'native_returned'}] };
    await writeIntent(intent);
    return { status: 'phone_submit_returned', smsSubmitAttempted: true, needsReconciliation: true,
      observedFieldOrder: observed.observedFieldOrder, otpFieldObserved: observed.otpFieldObserved,
      emailFieldObserved: observed.emailFieldObserved, accountCreated: false, newAccountVerified:false, marketingSelected: false,
      ...(followup?{followupCount:1,approvalId,previousIntentPreserved:true}:{}),
      ...(imported?{importedActivation:true,approvalId,previousIntentPreserved:true}:{}),
      implicitTermsAcceptedByContinue: true, artifacts: intent.artifacts };
  } catch (error) {
    intent = { ...intent, stage: 'needs_reconciliation', smsSubmitAttempted: intent.smsSubmitAttempted || submitAttempted, observedAt: Date.now(),
      ...(intent.smsSubmitAttempted?{submissionAttempts:[{...intent.submissionAttempts[0],outcome:'unknown'}]}:{}),
      nativeFailure: error.browserFailure || null, failureCode: error instanceof WorkerError ? error.code : 'registration_native_action_uncertain' };
    await writeIntent(intent);
    return { status: 'needs_reconciliation', smsSubmitAttempted: intent.smsSubmitAttempted,
      needsReconciliation: true, accountCreated: false, marketingSelected: false, artifacts: intent.artifacts,
      reason: error instanceof WorkerError ? error.code : 'registration_native_action_uncertain' };
  }
}

/** One operator-authorized resubmission of the same uncertain intent. No buy,
 * journal reset, arbitrary target, account adoption or automatic retry. */
export async function resumeRegistration({ client, check, remaining, capturePrivate, accountId, phone,
  root, bindingSecret, now = Date.now,
  readIntent = async () => JSON.parse(await readFile(`${root}/registration-intent.json`, 'utf8')),
  writeIntent = value => durableRegistrationWrite(root, value) }) {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(accountId || '') || !/^\+48\d{9}$/.test(phone || '')) throw new WorkerError('invalid_registration_input');
  if (typeof bindingSecret !== 'string' || bindingSecret.length < 32) throw new WorkerError('registration_binding_unavailable');
  let intent = await readIntent();
  const commitment = createHmac('sha256', bindingSecret).update(phone).digest('hex');
  if (!intent || intent.accountId !== accountId || intent.phoneCommitment !== commitment) throw new WorkerError('registration_binding_mismatch');
  const attempts = intent.submissionAttempts || (intent.smsSubmitAttempted ? [{attempt:1,outcome:'unknown',recordedAt:intent.observedAt,legacy:true}] : []);
  const authorizedFollowup=intent.followupCount===1&&intent.approvalId==='virtual53-test';
  const authorizedImported=intent.importedActivation===true&&intent.importedActivationCount===1&&intent.approvalId==='user-order-1094850855'&&intent.activationOrderId==='1094850855';
  if (!['needs_reconciliation','phone_submit_returned'].includes(intent.stage) || !(authorizedFollowup||authorizedImported) || !intent.smsSubmitAttempted || intent.resumeUsed || !Array.isArray(attempts) || attempts.length !== 1 || attempts[0]?.attempt !== 1) throw new WorkerError('registration_resume_not_permitted');
  if (!Number.isFinite(intent.observedAt) || now() - intent.observedAt < 60_000) throw new WorkerError('registration_resume_cooldown');
  const call = async (name, args) => {
    check();
    const r = await client.call(name,{session_id:SESSION_ID,...args},{timeoutMs:Math.max(1,Math.min(5000,remaining()))});
    check(); return structured(r);
  };
  const readView = async () => {
    const snapshot = await call('browser_snapshot',{max_elements:1000,interactive_only:true});
    registrationStructure(snapshot);
    const raw = await call('browser_get_content',{format:'html',max_bytes:524288});
    const html = typeof raw.content === 'string' ? raw.content : typeof raw.html === 'string' ? raw.html : typeof raw.text === 'string' ? raw.text : '';
    const structure = registrationStructure(snapshot,html);
    const accountControls=(snapshot.elements||[]).some(e=>['button','link','heading'].includes(e.role)&&/^(?:Moje konto|Wyloguj(?: się)?|Moje zamówienia)$/i.test(String(e.name||'').trim()));
    if (structure.otpFieldObserved || structure.emailFieldObserved || structure.passwordFieldObserved || accountControls) throw new WorkerError('registration_view_changed');
    return {snapshot,html};
  };
  let view = await readView();
  if (!phoneFormContract(view.html).ready) {
    // A graceful source reload can return to the merchant's blank homepage.
    // Only its existing entry reader may open the already grounded phone form.
    const structure = registrationStructure(view.snapshot,view.html);
    const observedSignIn=(view.snapshot.elements||[]).some(e=>e.role==='button'&&String(e.name||'').trim()==='Zaloguj się');
    if (!observedSignIn||structure.fields.some(f=>f.kind!=='unclassified'||!['search','text'].includes(f.inputType))) throw new WorkerError('registration_view_changed');
    await inspectRegistration({client,check,remaining});
    view = await readView();
  }
  let contract = phoneFormContract(view.html);
  if (!contract.ready || contract.currentDigits && contract.currentDigits !== phone.slice(3)) throw new WorkerError('registration_phone_controls_unverified');
  if (remaining() < 8000) throw new WorkerError('registration_deadline_before_input');
  const beforeArtifacts = await capturePrivate(view);
  intent = {...intent,resumeUsed:true,resumeReservedAt:now(),submissionAttempts:attempts,
    priorUnknown:{stage:intent.stage,observedAt:intent.observedAt,artifacts:intent.artifacts,nativeFailure:intent.nativeFailure??null,submissionAttempts:structuredClone(attempts),merchantSmsOutcomeVerified:false},
    artifacts:[...(intent.artifacts||[]),...beforeArtifacts]};
  await writeIntent(intent); // Reserve this sole resume before any refill.
  let retryPending = false;
  try {
    if (!contract.currentDigits) {
      const inputs = (view.snapshot.elements||[]).filter(e=>e.role==='textbox'&&e.input_type==='tel'&&typeof e.ref==='string');
      if (inputs.length !== 1) throw new WorkerError('registration_phone_ref_unverified');
      await call('browser_type',{ref:inputs[0].ref,text:phone.slice(3),clear_first:true,press_enter_after:false,timeout_ms:Math.max(1,Math.min(4000,remaining()))});
    }
    view = await readView(); contract = phoneFormContract(view.html);
    if (!contract.ready || contract.currentDigits !== phone.slice(3)) throw new WorkerError('registration_phone_value_unverified');
    const filledArtifacts = await capturePrivate(view);
    view = await readView(); contract = phoneFormContract(view.html);
    const buttons = (view.snapshot.elements||[]).filter(e=>e.role==='button'&&String(e.name||'').trim()==='Dalej'&&typeof e.ref==='string');
    if (!contract.ready || contract.currentDigits !== phone.slice(3) || buttons.length !== 1) throw new WorkerError('registration_submit_ref_unverified');
    if (remaining() < 4000) throw new WorkerError('registration_deadline_before_submit');
    intent = {...intent,stage:'sms_retry_pending',submissionAttempts:[...attempts,{attempt:2,outcome:'pending',recordedAt:now()}],
      artifacts:[...intent.artifacts,...filledArtifacts]};
    await writeIntent(intent); // The second and final submit is recorded BEFORE dispatch.
    retryPending = true;
    await call('browser_click',{ref:buttons[0].ref,timeout_ms:Math.max(1,Math.min(4000,remaining()))});
    let snapshot,html,after;
    // Read-only transition settling; never repeat a click or private input.
    for(let scan=0;scan<5;scan++) {
      snapshot = await call('browser_snapshot',{max_elements:1000,interactive_only:true});
      registrationStructure(snapshot);
      const raw = await call('browser_get_content',{format:'html',max_bytes:524288});
      html = typeof raw.content==='string'?raw.content:typeof raw.html==='string'?raw.html:typeof raw.text==='string'?raw.text:'';
      after = registrationStructure(snapshot,html);
      if(after.otpFieldObserved || after.emailFieldObserved || !after.phoneFieldObserved || scan===4 || remaining()<1500)break;
      await new Promise(resolve=>setTimeout(resolve,200));check();
    }
    const afterArtifacts = await capturePrivate({snapshot,html});
    intent = {...intent,stage:'phone_submit_returned',observedAt:now(),artifacts:[...intent.artifacts,...afterArtifacts],
      submissionAttempts:[attempts[0],{attempt:2,outcome:'native_returned',recordedAt:now()}]};
    await writeIntent(intent);
    return {status:'phone_submit_returned',smsSubmitAttempted:true,totalSubmitAttempts:2,needsReconciliation:true,
      otpFieldObserved:after.otpFieldObserved,emailFieldObserved:after.emailFieldObserved,observedFieldOrder:after.observedFieldOrder,
      accountCreated:false,newAccountVerified:false,marketingSelected:false,artifacts:intent.artifacts};
  } catch(error) {
    intent = {...intent,stage:'needs_reconciliation',observedAt:now(),nativeFailure:error.browserFailure||null,
      failureCode:error instanceof WorkerError?error.code:'registration_native_action_uncertain',
      ...(retryPending?{submissionAttempts:[attempts[0],{attempt:2,outcome:'unknown',recordedAt:now()}]}:{})};
    await writeIntent(intent);
    return {status:'needs_reconciliation',smsSubmitAttempted:true,totalSubmitAttempts:intent.submissionAttempts.length,
      needsReconciliation:true,accountCreated:false,newAccountVerified:false,reason:intent.failureCode,artifacts:intent.artifacts};
  }
}
