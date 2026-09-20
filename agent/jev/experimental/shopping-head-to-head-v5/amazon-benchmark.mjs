import {mkdir,writeFile,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright-core';
import {browserEnvironment} from '../../src/glovo.mjs';
import {saveJson} from '../../src/storage.mjs';
import {createLedger} from '../browser-runtime-v3/providers.mjs';
import {readOpenRouterItem} from '../browser-runtime-v3/credentials.mjs';
import {readHiddenKey} from '../browser-runtime-v4/session.mjs';
import {createRequestGuard} from './safety.mjs';
import {createJevPolicy,createLlmPolicy,literalTexts} from './deciders.mjs';
import {createMahmoudPolicy,UPSTREAM} from './upstream/mahmoud-policy.mjs';
import {runShopping} from './runtime.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const title='BIC Cristal Original Długopisy kulkowe, średnia końcówka (1 mm) - niebieskie, pudełko 10 sztuk';
const goal=`Search Amazon.pl from its homepage for "BIC Cristal niebieski 10". Open the exact product "${title}". Add exactly 1 pack to the empty guest cart, only if the item price is at most 25 PLN. View the cart and verify the exact item and quantity, then stop. Reject optional cookies. Never sign in, buy, enter checkout, or pay.`;
const task={goal,startURL:'https://www.amazon.pl/',texts:literalTexts(goal)};
const root=resolve('benchmarks/shopping-head-to-head-v5/results');
const sourceRoot=new URL('./',import.meta.url);
async function fingerprint(){const files={};async function walk(dir,prefix=''){for(const e of await readdir(dir,{withFileTypes:true})){const rel=prefix+e.name;if(e.isDirectory())await walk(new URL(e.name+'/',dir),rel+'/');else if(/\.(mjs|json)$/.test(e.name))files[rel]=sha(await readFile(new URL(e.name,dir)));}}await walk(sourceRoot);return{files,sha256:sha(JSON.stringify(files))};}
export async function verifyAmazon(page){
 const obs=await page.locator('body').evaluate(body=>({text:body.innerText,links:[...body.querySelectorAll('a[href]')].filter(e=>e.getClientRects().length).map(e=>({text:e.innerText.trim(),href:e.href})),groups:[...body.querySelectorAll('[role="group"]')].filter(e=>e.getClientRects().length).map(e=>e.getAttribute('aria-label'))}));
 const checks={cartPage:/\/cart\/view\.html/.test(page.url()),exactProduct:obs.links.some(a=>a.text.includes(title)&&a.href.includes('/dp/B0D9KJB4B1')),
  quantityOne:obs.groups.includes('Ilość wynosi 1'),oneCartItem:/Suma częściowa\s*\(1 produkt\)/.test(obs.text),noCheckout:!/(?:checkout|buy\/|purchase|placeorder)/i.test(page.url())};
 return{passed:Object.values(checks).every(Boolean),checks,observation:{url:page.url(),title:await page.title(),text:obs.text.slice(0,16000)}};
}
function upstreamChoose(apiKey,ledger,onEvent){const choose=createMahmoudPolicy({apiKey,ledger});let lastFilled;
 return async args=>{
  const allowedRefs=new Set(args.actions.map(a=>String(a.ref)));
  const observation={...args.observation,text:args.observation.text.slice(0,5000),elements:args.observation.elements.filter(e=>allowedRefs.has(String(e.ref))).map(e=>({...e,context:e.context.slice(0,120),bbox:[e.bbox.x,e.bbox.y,e.bbox.width,e.bbox.height]}))};
  const proposal=await choose({...args,observation,supportedActions:['click','fill','press']});await onEvent({type:'upstream_proposal',proposal});
  if(proposal.status==='done')return'done';if(proposal.status==='stop')return'unavailable';
  const p=proposal.action;
  const action=args.actions.find(a=>p.type===a.kind&&(p.ref===undefined?String(a.ref)===lastFilled:String(a.ref)===String(p.ref))&&(p.type!=='fill'||a.value===p.text)&&(p.type!=='press'||a.value===p.key));
  if(!action)throw Object.assign(new Error('upstream_action_outside_shared_menu'),{code:'upstream_action_outside_shared_menu'});
  if(p.type==='fill')lastFilled=String(action.ref);return action.id;
 };
}

const args=process.argv.slice(2), smoke=args.includes('--smoke');
const item=args.find(a=>a.startsWith('--openrouter-item='))?.slice(18)||'OpenRouter API Key - buenaapp';
const directory=join(root,`${smoke?'preflight':'amazon'}-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(directory,{recursive:true,mode:0o700});
const initial=await fingerprint();
const report={version:5,status:'starting',task,startedAt:new Date().toISOString(),source:initial,upstream:UPSTREAM,
 methodology:{workload:'One Amazon.pl cold guest search→exact product→one-pack cart task; no checkout. Two repetitions in reversed arm order.',
 ranking:['verified_success','time_per_verified_success_including_failures','model_cost_per_verified_success_including_failures'],
 observation:'Shared observed DOM and literal text slots; Jev joint-action vs Gemini Flash Lite joint-action vs normalized Mahmoud decision policy. Not end-to-end repository comparison.',
 timing:'From initial homepage navigation through final independent verification and hashed screenshot receipt; fresh browser and context setup, credential access and cleanup reported separately.',
 cost:'Jev input-token estimate plus OpenRouter returned charge. Infrastructure/proxies not instrumented: excluded, never claimed zero. No network retries; upstream corrective model retry included.',
 budget:'12 model requests/attempt, $0.02 known-spend threshold/attempt, $0.15/cohort; stop after unknown billing. No performance tuning/retest cohort.'},
 results:[],infrastructureCostUsd:null,proxyCostUsd:null,nodeVersion:process.version};
await saveJson(join(directory,'batch.json'),report);
let orKey,jevKey;
try {
 if(!smoke){console.log('Reading the authorized OpenRouter item; approve 1Password if prompted.');orKey=await readOpenRouterItem(item);jevKey=await readHiddenKey();}
 const arms=smoke?['preflight']:['jev-joint','flash-lite-joint','mahmoud-normalized'];
 const sequence=smoke?arms:[...arms,...[...arms].reverse()];report.plannedAttempts=sequence.length;
 for(const [index,arm] of sequence.entries()){
  if(report.results.some(r=>r.accounting&&!r.accounting.costComplete)||report.results.reduce((n,r)=>n+(r.accounting?.knownCostUsd||0),0)>=.15){report.stopReason='unknown_cost_or_budget';break;}
  const row={attempt:index+1,arm,repeat:Math.floor(index/arms.length)+1,status:'running',events:[],verifiedSuccess:false};report.results.push(row);
  const path=join(directory,`attempt-${index+1}.json`);let tail=Promise.resolve();
  const persist=()=>{const snapshot=structuredClone(row);const p=tail.then(()=>saveJson(path,snapshot));tail=p;return p;};
  const event=async e=>{row.events.push(e);await persist();};
  const ledger=createLedger({maxCalls:12,maxUsd:.02,onEvent:async e=>{row.accounting=ledger.summary();await event(e);}});
  let browser,context,page,started;const timeout=AbortSignal.timeout(90000);
  try {
   const setup=performance.now();browser=await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true,env:browserEnvironment(),timeout:20000});
   context=await browser.newContext({locale:'pl-PL',viewport:{width:1280,height:900},acceptDownloads:false,serviceWorkers:'block'});page=await context.newPage();
   row.setupMs=performance.now()-setup;row.browserVersion=browser.version();
   const policyContext={currentUrl:task.startURL,allowedOrigin:'https://www.amazon.pl',guestSession:true,ownedCartItemKeys:new Set()};
   const guard=createRequestGuard(policyContext,{onEvent:event});await context.route('**/*',async route=>{const d=await guard.route(route);if(!d.allowed){const req=route.request(),u=new URL(req.url());await event({type:'blocked_request_scope',reason:d.reason,origin:u.origin,pathname:u.pathname,method:req.method(),resourceType:req.resourceType()});}});
   const signal=AbortSignal.any([timeout,guard.signal]);context.on('page',p=>{if(p!==page)void p.close();});page.on('download',d=>void d.cancel());page.on('dialog',d=>void d.dismiss());
   started=performance.now();await page.goto(task.startURL,{waitUntil:'domcontentloaded',timeout:20000});
   await page.locator('body').evaluate(body=>new Promise(resolve=>{if(body.innerText.trim())return resolve();const observer=new MutationObserver(()=>{if(body.innerText.trim())finish();});const finish=()=>{observer.disconnect();clearTimeout(cap);resolve();};observer.observe(body,{childList:true,subtree:true,characterData:true});const cap=setTimeout(finish,8000);}),{},{timeout:9000});row.navigationMs=performance.now()-started;
   if(!(await page.locator('body').innerText()).trim())throw Object.assign(new Error('site_did_not_render'),{code:'site_did_not_render'});
   if(smoke){row.runtime={status:'preflight_only'};row.initial=await page.locator('body').innerText();}
   else {const choose=arm==='jev-joint'?createJevPolicy({apiKey:jevKey,ledger}):arm==='flash-lite-joint'?createLlmPolicy({apiKey:orKey,ledger}):upstreamChoose(jevKey,ledger,event);
    row.runtime=await runShopping({page,task,choose,policyContext,guard,signal,onEvent:event,maxSteps:12});}
   row.guard={...guard.counts};
  } catch(e){row.reason=/^[a-z_0-9]{1,90}$/.test(e.code||'')?e.code:'browser_or_runtime_error';row.errorName=e.name;}
  finally {
   try {row.verification=await verifyAmazon(page);row.verifiedSuccess=!smoke&&row.verification.passed&&!row.guard?.dangerousAborts;
    const png=await page.screenshot({fullPage:false,timeout:5000});const screenshot=`attempt-${index+1}.png`;await writeFile(join(directory,screenshot),png,{mode:0o600});
    row.evidence={stage:'cart_preparation_only',screenshot,screenshotSha256:sha(png),observationSha256:sha(JSON.stringify(row.verification.observation)),approval:null,confirmation:null};
   }catch{row.verification||={passed:false,reason:'verification_unavailable'};}
   row.accounting=ledger.summary();row.status=row.verifiedSuccess?'verified_success':'not_verified';row.totalMs=started===undefined?null:performance.now()-started;await persist();
   const cleanup=performance.now();await context?.close().catch(()=>{});await browser?.close().catch(()=>{});row.cleanupMs=performance.now()-cleanup;await persist();await saveJson(join(directory,'batch.json'),report);
  }
  console.log(JSON.stringify({attempt:row.attempt,arm,status:row.status,reason:row.reason||row.runtime?.reason,ms:row.totalMs,calls:row.accounting.modelCalls,cost:row.accounting.costUsd}));
 }
 report.status=report.results.length===report.plannedAttempts?'finished':'partial';
}catch(e){report.status='blocked';report.reason=/^[a-z_0-9]{1,90}$/.test(e.code||'')?e.code:'setup_failed';}
finally{orKey=null;jevKey=null;report.sourceUnchanged=initial.sha256===(await fingerprint()).sha256;await saveJson(join(directory,'batch.json'),report);console.log(JSON.stringify({directory,status:report.status,reason:report.reason}));}
