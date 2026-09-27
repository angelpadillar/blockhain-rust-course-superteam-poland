export const OPERATIONS = new Set(['readCatalogue','status','observeCart','mutateCart','quote','applyCoupon','inspectRegistration','inspectRegistrationState','startRegistration','startFollowupRegistration','resumeRegistration','startImportedRegistration']);
export const SESSION_ID='delio-owner';
export const INITIAL_URL='https://delio.com.pl/';
export class WorkerError extends Error {constructor(code){super(code);this.code=code;}}
export function reviewedBrowserHosts(config){
  if(config.initialUrl!==INITIAL_URL||!Array.isArray(config.allowedHosts)||config.allowedHosts.length!==1||config.allowedHosts[0]!=='delio.com.pl')throw new WorkerError('merchant_scope_unreviewed');
  const maps=config.reviewedMapHosts??[],auth=config.reviewedAuthHosts??[];
  if(!Array.isArray(maps)||maps.some(host=>!['maps.googleapis.com','maps.gstatic.com'].includes(host)))throw new WorkerError('map_dependency_unreviewed');
  if(!Array.isArray(auth)||auth.some(host=>host!=='identitytoolkit.googleapis.com'))throw new WorkerError('auth_dependency_unreviewed');
  return ['delio.com.pl',...new Set([...maps,...auth])];
}
export function validateRequest(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || !OPERATIONS.has(input.operation))throw new WorkerError('invalid_request');
  if(input.operation==='readCatalogue'){if(Object.keys(input).some(k=>!['operation','path'].includes(k))||input.path!==undefined&&(typeof input.path!=='string'||!/^\/(?:$|(?:categories|collections)\/[A-Za-z0-9_/-]+$)/.test(input.path)))throw new WorkerError('invalid_request');return input;}
  const followup=input.operation==='startFollowupRegistration';
  const imported=input.operation==='startImportedRegistration';
  const registrationAction=['startRegistration','startFollowupRegistration','resumeRegistration','startImportedRegistration'].includes(input.operation);
  const allowed=imported?['operation','accountId','phone','activationOrderId','approvalId']:followup?['operation','accountId','phone','previousPhone','previousActivationStatus','approvalId']:registrationAction?['operation','accountId','phone']:['operation','lines','selection'];
  if(Object.keys(input).some(key=>!allowed.includes(key)))throw new WorkerError('invalid_request');
  if(input.selection!==undefined&&input.selection!=='jev'&&input.selection!=='deterministic')throw new WorkerError('invalid_request');
  if(registrationAction&&(!/^[a-z][a-z0-9_-]{1,63}$/.test(input.accountId||'')||!/^\+48\d{9}$/.test(input.phone||'')))throw new WorkerError('invalid_request');
  if(followup&&(!/^\+48\d{9}$/.test(input.previousPhone||'')||input.phone===input.previousPhone||input.previousActivationStatus!=='TIMEOUT'||input.approvalId!=='virtual53-test'))throw new WorkerError('invalid_request');
  if(imported&&(input.activationOrderId!=='1094850855'||input.approvalId!=='user-order-1094850855'))throw new WorkerError('invalid_request');
  if(input.lines!==undefined){
    if(input.operation!=='mutateCart' || !Array.isArray(input.lines) || input.lines.length>50)throw new WorkerError('invalid_request');
    const ids=new Set();
    for(const line of input.lines){
      if(!line || Object.keys(line).some(key=>!['productId','quantity'].includes(key)) || !/^A\d{7}$/.test(line.productId) || ids.has(line.productId) || !Number.isSafeInteger(line.quantity) || line.quantity<0 || line.quantity>99)throw new WorkerError('invalid_request');
      ids.add(line.productId);
    }
  }
  if(input.operation==='mutateCart' && !Array.isArray(input.lines))throw new WorkerError('invalid_request');
  return input;
}
export function classifySnapshot(snapshot) {
  let url;try{url=new URL(snapshot?.url);}catch{throw new WorkerError('merchant_page_unverified');}
  if(url.origin!=='https://delio.com.pl')throw new WorkerError('merchant_origin_mismatch');
  const elements=Array.isArray(snapshot.elements)?snapshot.elements:[];
  const names=elements.filter(e=>['button','textbox','heading','dialog','combobox'].includes(e.role)).map(e=>String(e.name||'').replace(/\s+/g,' ').trim());
  const blockers=[];
  if(names.some(name=>/captcha|verify you are human|sprawdź, czy jesteś człowiekiem|access denied/i.test(name)))blockers.push({code:'merchant_challenge_required',message:'The merchant presents a challenge. No bypass was attempted.'});
  if(names.some(name=>/^Zaloguj się$/.test(name)))blockers.push({code:'merchant_login_required',message:'Delio displays a sign-in control. An authenticated owner session is not established.'});
  else blockers.push({code:'merchant_session_unverified',message:'The worker has not verified an authenticated owner session; absent login text alone is not proof.'});
  if(names.some(name=>/^Podaj adres dostawy/i.test(name)))blockers.push({code:'delivery_address_required',message:'Delio requests a delivery address. The exact address and delivery slot are not yet verified.'});
  else blockers.push({code:'delivery_selection_unverified',message:'The exact delivery address and required slot have not both been verified.'});
  blockers.push({code:'cart_operations_not_calibrated',message:'Account cart reading, cart edits and checkout quotation are not yet calibrated against an authenticated merchant page.'});
  return {status:'blocked',blockers,capabilities:{observeCart:false,mutateCart:false,quote:false},observations:{homepageReached:true,signInControlObserved:names.includes('Zaloguj się'),deliveryAddressRequested:names.some(name=>/^Podaj adres dostawy/i.test(name)),anonymousCartCounterObserved:names.some(name=>/^Twój koszyk, \d+ produktów?$/.test(name))}};
}
export function blocked(code,message){return {ok:false,code,dispatched:false,blockers:[{code,message}]};}
