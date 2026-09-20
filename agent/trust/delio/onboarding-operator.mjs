// Operator-only single-account hackathon runner. No HTTP route or arbitrary URL.
import {readFileSync,mkdirSync,openSync,writeFileSync,closeSync,unlinkSync,appendFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createCustomerOnboarding} from './customer-onboarding.mjs';
import {createFiveSimStore,createFiveSimAdapter} from './sms/fivesim.mjs';
import {remoteWorker} from './adapter.mjs';
import {createPrivateContactVault,readPrivateJson,writePrivateJson} from './private-store.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const fail=code=>{throw new Error(code);};
const safeError=error=>/^[a-z_]{1,100}$/.test(error?.message)?error.message:'onboarding_operation_failed';
export async function runOnboardingOperator({action='status',stopAfter,attempt='initial',privateDir=join(here,'private'),fetchImpl=fetch,invoke=remoteWorker}={}){
  if(!['status','preflight','advance','cancel','finish','refresh-sms','reconcile-before-purchase','retry-phone-submit','adopt-otp-stage'].includes(action))fail('invalid_operator_action');
  if(stopAfter!==undefined&&(!['mailbox_ready','phone_ready','awaiting_otp','otp_ready','registered'].includes(stopAfter)||action!=='advance'))fail('invalid_onboarding_stop');
  if(!['initial','virtual53'].includes(attempt))fail('invalid_onboarding_attempt');
  process.umask(0o077);
  const suffix=attempt==='initial'?'':'-virtual53';
  const dir=join(privateDir,'onboarding'+suffix);mkdirSync(dir,{recursive:true,mode:0o700});
  const lock=join(dir,'owner.lock');let fd;
  try{fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));}catch{fail('onboarding_owner_busy_review_lock');}
  const started=Date.now(),providerLock=join(privateDir,'onboarding-provider.lock');let providerFd;
  try{
    try{providerFd=openSync(providerLock,'wx',0o600);writeFileSync(providerFd,String(process.pid));}catch{fail('onboarding_provider_busy');}
    const config=readPrivateJson(join(privateDir,'onboarding-config'+suffix+'.json'));
    if(!config||config.mode!=='hackathon'||config.publicMailboxTestConsent!==true||config.account?.newCustomer!==true)fail('single_test_consent_required');
    const account=config.account,actor={customerId:account.customerId,merchantAccountId:account.merchantAccountId};
    let previous;
    if(attempt==='virtual53'){
      const original=readPrivateJson(join(privateDir,'onboarding-config.json'));
      const oldState=readPrivateJson(join(privateDir,'onboarding/customer-onboarding.json'));
      const oldSms=readPrivateJson(join(privateDir,'onboarding/sms-ledger.json'));
      const entry=oldState?.entries?.[account.customerId];
      if(config.additionalTestAuthorized!==true||config.approvedNamedOperator?.approvalId!=='virtual53-test'
        ||original?.account?.customerId!==account.customerId||original.account.merchantAccountId!==account.merchantAccountId
        ||entry?.merchantAccountId!==account.merchantAccountId||entry.phase==='registered'||entry.phoneReady!==true
        ||oldSms?.entries?.length!==1||oldSms.entries[0].reservationId!==entry.smsReservationId
        ||oldSms.entries[0].phase!=='owned'||oldSms.entries[0].status!=='TIMEOUT')fail('additional_test_not_authorized_or_previous_not_terminal');
      previous={config:original,entry:oldSms.entries[0],store:oldSms};
    }
    const vault=createPrivateContactVault({dir,customerId:account.customerId});
    const storeFile=join(dir,'sms-ledger.json');
    const store=createFiveSimStore({initial:readPrivateJson(storeFile),durableWrite:s=>writePrivateJson(storeFile,s)});
    const token=readFileSync(join(privateDir,'fivesim-token.txt'),'utf8').trim();
    const provider=createFiveSimAdapter({paidEnabled:config.paidSmsEnabled===true,token,store,budget:config.budget,service:config.service,approvedNamedOperator:config.approvedNamedOperator,exclusiveProviderAccount:true,fetchImpl,maxPollMs:30000,maxPolls:10});
    const sms=attempt==='virtual53'?{...provider,buy:({onPhone})=>provider.buy({operator:'virtual53',onPhone})}:provider;
    const mailbox={
      capabilities:async()=>({verified:true,privateMailbox:false,publicMailbox:true,testOnly:true,origin:'https://fviainboxes.com'}),
      async create({customerId,onEmail}){
        const saved=readPrivateJson(join(privateDir,'mailbox-smoke.json'));
        if(customerId!==account.customerId||saved?.publicInboxConsent!==true||saved?.purpose!=='single_authorized_hackathon_account'
          ||typeof saved.email!=='string'||!saved.email.endsWith('@fviainboxes.com'))fail('observed_test_mailbox_required');
        // Adopt the one mailbox already opened and reviewed in the browser.
        // This does not claim verified inbound delivery or create another inbox.
        await onEmail(saved.email);
      },
    };
    const merchantCall=async(operation,fields={})=>{
      const began=Date.now();
      appendFileSync(join(dir,'merchant-attempts.jsonl'),JSON.stringify({operation,startedAt:began,event:'start'})+'\n',{mode:0o600,flush:true});
      const response=await invoke({operation,...fields});
      const r=response?.result;
      appendFileSync(join(dir,'merchant-attempts.jsonl'),JSON.stringify({operation,startedAt:began,event:'returned',durationMs:Date.now()-began,ok:response?.ok===true,
        code:response?.ok===true?null:safeError({message:response?.code}),status:r?.status??null,observedAt:r?.observedAt??null,evidenceRefs:r?.evidenceRefs??[],browserRuntimeMs:r?.browserRuntimeMs??null,
        otpFieldObserved:r?.otpFieldObserved===true,phoneSubmissionReady:r?.phoneSubmissionReady===true,registered:r?.registered===true})+'\n',{mode:0o600,flush:true});
      if(response?.ok!==true)fail(/^[a-z_]{1,100}$/.test(response?.code)?response.code:'merchant_registration_unavailable');
      return response.result;
    };
    const merchant={
      async inspectRegistration({accountId}){
        if(accountId!==account.merchantAccountId)fail('account_not_owned');
        const r=await merchantCall('inspectRegistration');
        const ready=r.phoneSubmissionReady===true||(attempt==='virtual53'&&r.followupSubmissionReady===true&&r.registrationIntentAccountId===accountId);
        const verified=r.phoneFieldObserved===true&&r.fields?.filter(f=>f.kind==='phone').length===1&&ready;
        return {verified,merchantAccountId:accountId,evidenceId:r.evidenceRefs?.[0]?.id,observedAt:r.observedAt};
      },
      async startRegistration({accountId,phone}){
        if(accountId!==account.merchantAccountId)fail('account_not_owned');
        let r;
        if(previous){
          const oldDir=join(privateDir,'onboarding'),oldStore=createFiveSimStore({initial:readPrivateJson(join(oldDir,'sms-ledger.json')),durableWrite:s=>writePrivateJson(join(oldDir,'sms-ledger.json'),s)});
          const oldProvider=createFiveSimAdapter({paidEnabled:true,token,store:oldStore,budget:previous.config.budget,service:previous.config.service,exclusiveProviderAccount:true,fetchImpl});
          const terminal=await oldProvider.reconcile({reservationId:previous.entry.reservationId});
          if(terminal.status!=='TIMEOUT')fail('previous_activation_not_terminal');
          const oldVault=createPrivateContactVault({dir:oldDir,customerId:account.customerId});
          await oldVault.withSecret(account.customerId,'activationPhone',async previousPhone=>{
            r=await merchantCall('startFollowupRegistration',{accountId,phone,previousPhone,previousActivationStatus:'TIMEOUT',approvalId:'virtual53-test'});
          });
        }else r=await merchantCall('startRegistration',{accountId,phone});
        return {otpRequired:r.otpRequired===true||(r.status==='phone_submit_returned'&&r.otpFieldObserved===true)};
      },
      async completeRegistration({accountId,otp}){
        if(accountId!==account.merchantAccountId)fail('account_not_owned');
        const r=await merchantCall('completeRegistration',{accountId,otp});
        return {registered:r.registered===true,merchantAccountId:accountId,evidenceId:r.evidenceRefs?.[0]?.id,observedAt:r.observedAt};
      },
    };
    const onboarding=createCustomerOnboarding({accounts:[account],storeDir:dir,exclusiveOwner:true,mailbox,sms,merchant,vault,mode:'hackathon',publicMailboxTestConsent:true});
    let result;
    if(action==='status')result={onboarding:onboarding.status(actor),sms:await sms.publicStatus()};
    else if(action==='preflight')result=await sms.publicPreflight({product:'zabkajush',minimumRate:90});
    else if(action==='refresh-sms'){
      const current=onboarding.status(actor),smsState=await sms.publicStatus();
      if(smsState.entries.length!==1||smsState.entries[0].state!=='owned'||typeof current.sms.reservationId!=='string'
        ||smsState.entries[0].reservationId!==current.sms.reservationId)fail('owned_activation_required');
      result=await sms.reconcile({reservationId:current.sms.reservationId});
    }
    else if(action==='reconcile-before-purchase'){
      const current=onboarding.status(actor);
      if(current.pending?.operation!=='buy_sms')fail('no_pre_purchase_reconciliation');
      const metadata=readFileSync(join(here,'evidence/fivesim-history-diagnostic.json'));
      const diagnostic=JSON.parse(metadata);
      if(diagnostic.httpStatus!==200||diagnostic.total!==999999)fail('pre_purchase_diagnostic_required');
      result=await onboarding.operatorReconcile(actor,{operationId:current.pending.operationId,outcome:'sms_not_dispatched',
        evidenceId:createHash('sha256').update(metadata).digest('hex'),observedAt:diagnostic.observedAt});
    }
    else if(['retry-phone-submit','adopt-otp-stage'].includes(action)){
      const current=onboarding.status(actor),smsState=await sms.publicStatus();
      if(current.pending?.operation!=='start_registration'||smsState.needsReconciliation||smsState.entries.length!==1
        ||typeof current.sms.reservationId!=='string'||smsState.entries[0].reservationId!==current.sms.reservationId
        ||smsState.entries[0].state!=='owned'||!['PENDING','RECEIVED'].includes(smsState.entries[0].status)
        ||!Number.isFinite(smsState.entries[0].expiresAt)||smsState.entries[0].expiresAt<=Date.now())fail('registration_retry_not_owned');
      let r;
      if(action==='retry-phone-submit'){
        // Recheck the owned activation immediately before the sole same-number
        // retry. An existing or unknown SMS count must never trigger a resend.
        const fresh=await sms.reconcile({reservationId:current.sms.reservationId});
        if(fresh.reconciled!==true||fresh.state!=='owned'||fresh.smsCount!==0
          ||!['PENDING','RECEIVED'].includes(fresh.status)||!Number.isFinite(fresh.expiresAt)
          ||fresh.expiresAt<=Date.now())fail('registration_retry_sms_not_ready');
        await vault.withSecret(account.customerId,'activationPhone',async phone=>{
          r=await merchantCall('resumeRegistration',{accountId:account.merchantAccountId,phone});
        });
      }
      else r=await merchantCall('inspectRegistrationState');
      if(r?.otpFieldObserved!==true)fail('otp_stage_unverified');
      result=await onboarding.operatorReconcile(actor,{operationId:current.pending.operationId,outcome:'awaiting_otp',
        evidenceId:r.evidenceRefs?.[0]?.id,observedAt:r.observedAt});
    }
    else if(action==='advance'){
      const current=onboarding.status(actor),smsState=await sms.publicStatus();
      if(current.phase!=='registered'&&smsState.entries.some(e=>['CANCELED','TIMEOUT','FINISHED','BANNED'].includes(e.status)))fail('activation_terminal_requires_review');
      if(current.phase!=='registered'&&smsState.entries.some(e=>Number.isFinite(e.expiresAt)&&e.expiresAt<=Date.now()))fail('activation_expired_requires_review');
      result=await onboarding.advance(actor,{stopAfter});
    }
    else {
      const owned=onboarding.status(actor),smsState=await sms.publicStatus();
      if(owned.pending||smsState.needsReconciliation||smsState.entries.length!==1)fail('cleanup_requires_owned_reconciled_activation');
      if(typeof owned.sms.reservationId!=='string'||owned.sms.reservationId!==smsState.entries[0].reservationId)fail('cleanup_requires_owned_reconciled_activation');
      if(action==='finish'&&owned.phase!=='registered'||action==='cancel'&&owned.phase==='registered')fail('cleanup_stage_mismatch');
      result=await sms.mutateOwned({reservationId:smsState.entries[0].reservationId,operation:action});
    }
    appendFileSync(join(dir,'operator-attempts.jsonl'),JSON.stringify({at:started,action,stopAfter:stopAfter??null,durationMs:Date.now()-started,ok:true})+'\n',{mode:0o600,flush:true});
    return result;
  }catch(error){
    const code=safeError(error);appendFileSync(join(dir,'operator-attempts.jsonl'),JSON.stringify({at:started,action,stopAfter:stopAfter??null,durationMs:Date.now()-started,ok:false,code})+'\n',{mode:0o600,flush:true});throw new Error(code);
  }finally{if(providerFd!==undefined){closeSync(providerFd);unlinkSync(providerLock);}closeSync(fd);unlinkSync(lock);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(await runOnboardingOperator({action:process.argv[2]||'status',stopAfter:process.argv[3],attempt:process.env.DELIO_ONBOARDING_ATTEMPT||'initial'})));}
  catch(error){console.log(JSON.stringify({ok:false,code:safeError(error)}));process.exitCode=1;}
}
