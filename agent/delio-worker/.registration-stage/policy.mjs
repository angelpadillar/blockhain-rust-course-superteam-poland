export const OPERATIONS = new Set(['status','observeCart','mutateCart','quote','inspectRegistration']);
export const SESSION_ID='delio-owner';
export const INITIAL_URL='https://delio.com.pl/';
export class WorkerError extends Error {constructor(code){super(code);this.code=code;}}
export function validateRequest(input) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!['operation','lines'].includes(key)) || !OPERATIONS.has(input.operation))throw new WorkerError('invalid_request');
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
