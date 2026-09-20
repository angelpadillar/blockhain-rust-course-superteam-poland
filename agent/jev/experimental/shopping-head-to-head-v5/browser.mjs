import { classifyAction, validateAction } from './safety.mjs';

export const norm=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const policyFields=['ref','operation','kind','label','href','formAction','formMethod','inputType','value','role','tag','cartItemKey'];
export const policyAction=a=>Object.fromEntries(policyFields.filter(k=>a[k]!==undefined).map(k=>[k,a[k]]));
export function inspect(body) {
 const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
 const visible=n=>n.isConnected&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden'&&!n.closest('[aria-hidden="true"],[hidden]');
 const dialog=[...body.querySelectorAll('[role="dialog"],dialog')].filter(visible).at(-1);
 const nodes=[...(dialog||body).querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="option"],[role="tab"],[role="radio"]')];
 const elements=nodes.flatMap((n,index)=>{
  if(!visible(n)||n.disabled||n.getAttribute('aria-disabled')==='true'||['hidden','password','email','tel','file'].includes(n.type))return [];
  const tag=n.tagName.toLowerCase(), type=n.type||'';
  const label=norm(n.getAttribute('aria-label')||[...(n.labels||[])].map(x=>x.innerText).join(' ')||n.getAttribute('placeholder')||n.innerText||n.getAttribute('title')||(['submit','button'].includes(type)?n.value:'')||'').slice(0,260);
  if(!label&&!['select','input'].includes(tag))return [];
  const container=n.closest('article,li,[data-asin],[role="group"],fieldset,section,form')||n.parentElement;
  const form=n.form||n.closest('form');
  const box=n.getBoundingClientRect();
  return [{index,id:String(index),ref:String(index),tag,type,inputType:type,role:n.getAttribute('role')||(tag==='a'?'link':tag==='button'?'button':tag==='select'?'combobox':type==='search'?'searchbox':'textbox'),
   label,text:label,value:typeof n.value==='string'?n.value.slice(0,220):'',href:tag==='a'?n.href:'',
   formAction:n.getAttribute('formaction')?n.formAction:form?.action||'',formMethod:(n.getAttribute('formmethod')||form?.method||'').toUpperCase(),context:norm(container?.innerText).slice(0,350),
   options:tag==='select'?[...n.options].map(o=>({label:o.label,value:o.value,disabled:o.disabled,selected:o.selected})).slice(0,30):[],
   bbox:{x:box.x,y:box.y,width:box.width,height:box.height}}];
 });
 return {nodes,data:{url:location.href,title:document.title,text:norm((dialog||body).innerText).slice(0,9000),elements}};
}
export function actionMenu(observation,task,context) {
 const actions=[];
 const texts=task.texts||[];
 const add=(el,a)=>{const action={...el,...a}; if(classifyAction(policyAction(action),context).allowed)actions.push(action);};
 for(const e of observation.elements) {
  if(['input','textarea'].includes(e.tag)&&['search','text',''].includes(e.type)&&/search|szuk|find|wyszuk/i.test(e.label+' '+e.role)) {
   for(const value of texts.filter(s=>!/^[0-9]+$/.test(s))) if(e.value!==value)add(e,{operation:'search',kind:'fill',value});
   if(e.value)add(e,{operation:'search',kind:'press',value:'Enter'});
  } else if(e.tag==='select') {
   for(const o of e.options.filter(o=>!o.disabled&&!o.selected)) {
    const qty=/qty|quantity|ilość|ilosc/i.test(e.label);
    if(qty&&!texts.includes(o.label)&&!texts.includes(o.value))continue;
    add(e,{operation:qty?'set_quantity':'choose_option',kind:'select',value:o.value,optionLabel:o.label,label:e.label||'Product option'});
   }
  } else if(['button','a'].includes(e.tag)||['submit','button'].includes(e.type)||['button','option','tab','radio'].includes(e.role)) {
   const s=e.label;
   const operation=/add to (?:cart|basket)|dodaj do koszyk/i.test(s)?'add_to_cart':/reject|odrzuć|necessary only|nie teraz/i.test(s)?'dismiss_cookie':/cart|basket|koszyk/i.test(s)?'view_cart':e.tag==='a'?'open_product':context.allowTestSettings&&/save|apply|reading|dark|light|compact|comfortable/i.test(s)?'test_preference':'choose_option';
   add(e,{operation,kind:'click'});
  }
 }
 // Same lexical shortlist for every policy; truncation remains explicit evidence.
 const words=task.goal.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>2);
 const score=a=>words.reduce((n,w)=>n+(a.label+' '+a.context).toLowerCase().includes(w),0)+(['search','add_to_cart','view_cart','dismiss_cookie','set_quantity'].includes(a.operation)?10:0);
 const chosen=actions.map((a,i)=>({a,i,score:score(a)})).sort((a,b)=>b.score-a.score||a.i-b.i).slice(0,40).sort((a,b)=>a.i-b.i).map(({a},i)=>({...a,id:`a${i}`}));
 return {actions:chosen,totalActions:actions.length,omittedActions:Math.max(0,actions.length-chosen.length)};
}
export function createShoppingBrowser({page,policyContext,guard,signal}) {
 let handle, data, used=false;
 return {
  async observe(){await handle?.dispose().catch(()=>{}); handle=await page.locator('body').evaluateHandle(inspect,{},{timeout:3000});data=await handle.evaluate(s=>s.data);used=false;return data;},
  async execute(action){
   signal.throwIfAborted();guard?.throwIfStopped();validateAction(policyAction(action),policyContext);
   if(used||page.url()!==data.url)throw Object.assign(new Error('stale_action'),{code:'stale_action'});
   const element=(await handle.evaluateHandle((s,index)=>s.nodes[index],action.index)).asElement();
   if(!element)throw Object.assign(new Error('stale_action'),{code:'stale_action'});
   const current=await element.evaluate(n=>({connected:n.isConnected,href:n.tagName==='A'?n.href:'',value:typeof n.value==='string'?n.value.slice(0,220):'',label:(n.getAttribute('aria-label')||[...(n.labels||[])].map(x=>x.innerText).join(' ')||n.getAttribute('placeholder')||n.innerText||n.getAttribute('title')||(['submit','button'].includes(n.type)?n.value:'')||'').replace(/\s+/g,' ').trim().slice(0,260)}));
   if(!current.connected||current.label!==action.label&&action.label!=='Product option'||current.href!==action.href||current.value!==action.value&&['fill','press','select'].includes(action.kind)&&current.value!==data.elements.find(e=>e.index===action.index)?.value)throw Object.assign(new Error('stale_action'),{code:'stale_action'});
   used=true;
   // Permit must be created from observed form metadata, never a model URL.
   const classification=classifyAction(policyAction(action),policyContext);
   if(['cart_mutation','test_preference'].includes(classification.category))guard?.authorize?.(policyAction(action),policyContext);
   try {
    if(action.kind==='click')await element.click({timeout:5000});
    else if(action.kind==='fill')await element.fill(action.value,{timeout:3000});
    else if(action.kind==='press')await element.press('Enter',{timeout:5000});
    else if(action.kind==='select')await element.selectOption(action.value,{timeout:3000});
    else throw Object.assign(new Error('unsupported_action'),{code:'unsupported_action'});
   } finally {await element.dispose().catch(()=>{});}
   await page.waitForLoadState('domcontentloaded',{timeout:5000}).catch(()=>{});
   // Bounded event settling; no page-wide 800ms minimum and no networkidle.
   if(action.kind!=='fill')await page.locator('body').evaluate(body=>new Promise(resolve=>{
    let quiet;const observer=new MutationObserver(()=>{clearTimeout(quiet);quiet=setTimeout(finish,80);});
    const finish=()=>{observer.disconnect();clearTimeout(quiet);clearTimeout(cap);resolve();};
    observer.observe(body,{subtree:true,childList:true,characterData:true});const cap=setTimeout(finish,1200);quiet=setTimeout(finish,80);
   }),{},{timeout:2000}).catch(()=>{});
   guard?.finishAction();
  },
  async close(){await handle?.dispose().catch(()=>{});}
 };
}
