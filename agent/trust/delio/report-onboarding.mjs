// Sanitized read-only reporting; contacts and provider order IDs never leave private storage.
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const read=(file,fallback)=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const events=file=>{try{return readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
const previousReport=read(join(here,'evidence/onboarding-live-test.json'),null);
const attempts=[];
for(const [name,suffix] of [['initial',''],['virtual53','-virtual53']]){
  const dir=join(here,'private','onboarding'+suffix),state=read(join(dir,'customer-onboarding.json'),null);
  if(!state){
    if(previousReport?.attempts?.some(a=>a.name===name))throw new Error('historical_private_ledger_required_for_report');
    continue;
  }
  const entries=Object.values(state.entries);if(entries.length!==1)throw new Error('single_test_report_scope');
  const entry=entries[0],ledger=read(join(dir,'sms-ledger.json'),{entries:[]});
  const operatorAttempts=events(join(dir,'operator-attempts.jsonl')).filter(x=>x.action!=='status');
  const merchantAttempts=events(join(dir,'merchant-attempts.jsonl'));
  const purchases=ledger.entries.map(e=>({state:e.phase,providerStatus:e.status??null,operator:e.operator??null,
    grossCostUsd:e.costMinor===null?null:e.costMinor/1_000_000,refundedUsd:null,refundVerified:false,
    costCapMechanism:e.capMechanism??'provider_maxPrice_any',approvalId:e.approvalId??null}));
  attempts.push({name,phase:entry.pending?'reconciliation_required':entry.phase,pendingOperation:entry.pending?.operation??null,
    mailboxPrepared:entry.mailboxReady,otpReady:entry.otpReady,merchantAccountVerified:entry.phase==='registered',
    purchases,operatorAttempts,merchantAttempts,
    operatorRuntimeMs:operatorAttempts.reduce((n,e)=>n+e.durationMs,0),
    nestedMerchantControllerMs:merchantAttempts.filter(e=>e.event==='returned').reduce((n,e)=>n+e.durationMs,0),
    nestedBrowserRuntimeMs:merchantAttempts.filter(e=>e.event==='returned').reduce((n,e)=>n+(e.browserRuntimeMs??0),0)});
}
// A user-purchased activation is separate from the two operator purchase
// ledgers. Count its observed account only when the independent profile match
// confirms the new-profile flow and every supplied field.
const importedProof=read(join(here,'evidence/user-purchased-account-verification.json'),null);
const importedProvider=read(join(here,'evidence/user-purchased-final-provider-status.json'),null);
const importedVerified=importedProof?.verifiedAccountProfile===true&&['accountPageObserved','newProfileFlowObserved','firstNameMatches','lastNameMatches','dateOfBirthMatches','emailMatches','phoneMatches'].every(k=>importedProof[k]===true)
  &&importedProof.artifacts?.length>=2&&importedProof.artifacts.every(a=>a.hashesVerified===true&&/^[a-f0-9]{64}$/.test(a.observationSha256)&&/^[a-f0-9]{64}$/.test(a.screenshotSha256));
if(importedProvider?.purchasedBy==='user'){
  const start=read(join(here,'evidence/user-purchased-registration-start.json'),null);
  const resume=read(join(here,'evidence/user-purchased-registration-resume.json'),null);
  const firstCheck=read(join(here,'evidence/user-purchased-activation-check.json'),null);
  const profile=read(join(here,'evidence/user-purchased-account-profile-observation.json'),null);
  attempts.push({name:'user_purchased_import',phase:importedVerified?'registered_observed':'profile_verification_pending',pendingOperation:null,
    mailboxPrepared:true,otpReady:importedProvider.smsCount>0,merchantAccountVerified:importedVerified,
    autonomous:false,assistance:'Native worker plus Codex through the approved desktop and explicit user inputs/approvals',
    purchases:[{state:'owned',providerStatus:importedProvider.status,operator:'virtual53',purchasedBy:'user',grossCostUsd:importedProvider.priceUsd,refundedUsd:null,refundVerified:false,costCapMechanism:'already_purchased_by_user'}],
    controllerAttempts:[start,resume].filter(Boolean).map(r=>({observedAt:r.observedAt,durationMs:r.controllerRuntimeMs,status:r.result?.result?.status??null,browserRuntimeMs:r.result?.result?.browserRuntimeMs??null})),
    observedSignupIntervalMs:profile?.result?.observedAt&&firstCheck?.observedAt?profile.result.observedAt-firstCheck.observedAt:null,
    intervalIncludes:['setup','dependency correction','permission waits','Codex desktop interaction','user profile instructions'],
    automatedCoordinatorReconciled:false,profileProof:'user-purchased-account-verification.json'});
}
const purchases=attempts.flatMap(a=>a.purchases),known=purchases.every(p=>p.grossCostUsd!==null);
const report={observedAt:Date.now(),scope:'One hackathon customer, one prepared mailbox, explicitly authorized activation attempts; no merchant purchase/payment',
  smsPurchases:purchases.length,grossSmsCostUsd:known?Math.round(purchases.reduce((n,p)=>n+p.grossCostUsd,0)*1e6)/1e6:null,
  netSmsCostUsd:null,refundEvidence:{userReportedFirstRefund:true,providerCreditIndependentlyVerified:false},
  verifiedMerchantAccounts:attempts.some(a=>a.merchantAccountVerified)?1:0,autonomousVerifiedMerchantAccounts:0,mailboxAssociatedWithMerchant:importedVerified,emailDeliveryVerified:false,couponActivated:false,verifiedCheckoutQuotes:0,merchantOrders:0,
  attempts,limitations:['Runtime totals include failed attempts; nested timings must not be added again.','The observed signup required Codex desktop actions and user input; it is not an autonomous Jev benchmark.','The older automated coordinator attempts remain pending and were not silently reconciled to another activation.','Provider TIMEOUT and a refund promise are not a reconciled credit.','Earlier attempts did not prove merchant SMS dispatch and cannot establish provider delivery failure rates.','Model, infrastructure and manual support costs are separate; these are SMS charges only.']};
report.grossSmsCostPerVerifiedAccountUsd=report.verifiedMerchantAccounts&&known?report.grossSmsCostUsd/report.verifiedMerchantAccounts:null;
report.totalCostPerVerifiedAccountUsd=null; // Codex assistance and infrastructure are not fully metered.
writeFileSync(join(here,'evidence/onboarding-live-test.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({saved:true,smsPurchases:report.smsPurchases,grossSmsCostUsd:report.grossSmsCostUsd,verifiedMerchantAccounts:report.verifiedMerchantAccounts}));
