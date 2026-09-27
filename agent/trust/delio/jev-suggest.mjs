import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
// Bounded Jev suggestions for the planner UI. Same contract as the worker's
// control picker: Jev only ever chooses among a candidate list we built; a
// choice below the confidence gate is treated as "no suggestion". Suggestions
// are planning aids — they never touch the merchant cart.
const here=dirname(fileURLToPath(import.meta.url));
const model='jev-1.13.0',ENDPOINT='https://api.typesafe.ai/v1/systemone';
const hash=s=>createHash('sha256').update(JSON.stringify(s)).digest('hex');
const fail=s=>{const e=new Error(s);e.code=s;return e;};
const apiKey=()=>readFileSync(join(here,'private/typesafe-key.txt'),'utf8').trim();
// Persisted call ledger + answer cache. Interactive suggestions stay cheap
// because identical requests (same candidates, same task) hit the cache.
const LEDGER=join(here,'private/jev-suggest-ledger.json'),CALL_CAP=400;
function ledger(){
 mkdirSync(join(here,'private'),{recursive:true,mode:0o700});
 try{return JSON.parse(readFileSync(LEDGER));}catch{return {attempts:0,cache:{}};}
}
function save(l){writeFileSync(LEDGER+'.tmp',JSON.stringify(l),{mode:0o600});renameSync(LEDGER+'.tmp',LEDGER);}
export async function jevAsk({state,questions},{timeoutMs=15000}={}){
 const request={model,state,questions},k=hash(request),l=ledger();
 if(l.cache[k])return {...l.cache[k],cached:true};
 if(l.attempts>=CALL_CAP)throw fail('jev_suggest_budget_exhausted');
 l.attempts++;save(l);
 const r=await fetch(ENDPOINT,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${apiKey()}`,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(timeoutMs)});
 if(!r.ok)throw fail('typesafe_http_'+r.status);
 const response=await r.json();
 l.cache[k]=response;save(l);
 return response;
}
// Ask Jev to pick among product candidates; returns accepted picks ordered by
// probability. `criteria` maps candidate keys -> short labels; candidates are
// the product objects Jev sees in state.
export function picks(response,questionId,{minProb=0.45,maxPicks=3}={}){
 const a=response?.answers?.[questionId];
 if(!a||a.type!=='choice')return [];
 return Object.entries(a.probabilities||{})
  .filter(([k,p])=>k!=='none'&&Number.isFinite(p)&&p>=minProb)
  .sort((x,y)=>y[1]-x[1]).slice(0,maxPicks)
  .map(([k,p])=>({key:k,probability:p}));
}
export const FACETS={breakfast:'breakfast / śniadanie',lunch_dinner:'lunch or dinner main',snack:'snack / przekąska',party:'party & entertaining',kids:'for children',healthy:'health & diet',sweets:'sweets & desserts',household:'household & cleaning',any:'anything'};
