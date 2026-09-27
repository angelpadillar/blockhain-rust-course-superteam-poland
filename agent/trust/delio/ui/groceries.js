import {planBasket} from './grocery-planner.mjs';
import {filterCatalogueItems,productImageUrl} from './catalogue-view.mjs';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>Number.isSafeInteger(n)?new Intl.NumberFormat('pl-PL',{style:'currency',currency:'PLN'}).format(n/100):'Not checked';
const date=n=>n?new Date(n).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Unknown';
let data=null,lines=[],query='',category='',regionId='krakow';
let pref='',sort='relevance',intentItems=null,intentNote='';
// Merchant notes per product from the last verify (session-only): what Delio
// actually allowed, shown inline on the basket line.
const notes=new Map();
const storageKey='buena-delio-draft-v1';
function store(){try{localStorage.setItem(storageKey,JSON.stringify({regionId,lines}));}catch{}}
function restore(){try{const draft=JSON.parse(localStorage.getItem(storageKey));if(draft){planBasket({items:data.items,lines:draft.lines,regionId:draft.regionId,indexRegionId:data.regionId});lines=draft.lines;regionId=draft.regionId;}}catch{lines=[];} }
function render(){
 if(!data)return;
 const regionMatches=regionId===data.regionId;
 let visible=regionMatches?(intentItems||filterCatalogueItems(data.items,{query,categoryId:category})):[];
 if(pref)visible=visible.filter(p=>p.attrs?.[pref]);
 visible=[...visible].sort((a,b)=>sort==='price-asc'?a.unitPriceMinor-b.unitPriceMinor:sort==='price-desc'?b.unitPriceMinor-a.unitPriceMinor:sort==='staple'?(b.scores?.staple??-1)-(a.scores?.staple??-1):sort==='health'?(b.scores?.health??-1)-(a.scores?.health??-1):sort==='value'?(parseFloat(b.packSize)||0)-(parseFloat(a.packSize)||0):0);
 $('smart-search').hidden=!query||intentItems!==null;
 $('search-note').hidden=!intentNote;$('search-note').textContent=intentNote;
 $('region').value=regionId;
 $('count').textContent=`${visible.length} of ${regionMatches?data.items.length:0} products`;
 $('freshness').textContent=regionMatches?`Kraków listing snapshot · ${date(data.observedAt)} · Stock is rechecked before ordering.`:'Warsaw has not been collected. Choose Kraków to use this catalogue; its prices do not transfer to another city.';
 $('categories').innerHTML=[{id:'',label:'All groceries'},...data.categories].map(c=>`<button data-category="${esc(c.id)}" class="${category===c.id?'active':''}">${esc(c.label)}</button>`).join('');
 $('products').innerHTML=visible.length?visible.map(p=>{
  const image=productImageUrl(p),qty=lines.find(l=>l.productId===p.productId)?.quantity||0;
  return `<article class="g-product"><div class="g-photo"><span>Photo unavailable</span>${image?`<img src="${esc(image)}" alt="${esc(p.title)}" loading="lazy" decoding="async" width="150" height="135">`:''}</div><h3>${esc(p.title)}</h3><p class="pack">${esc(p.packSize)}</p>${p.attrs&&(p.attrs.vegetarian||p.attrs.glutenFree||p.attrs.kidFriendly)?`<p class="jev-tags">${[p.attrs.vegetarian&&'vege',p.attrs.glutenFree&&'gluten-free',p.attrs.kidFriendly&&'kids'].filter(Boolean).map(t=>`<span>${t}</span>`).join('')}</p>`:''}<div class="g-price-row"><span class="g-price">${esc(money(p.unitPriceMinor))}</span><button class="g-add" data-add="${p.productId}" aria-label="Add ${esc(p.title)} to basket plan" ${qty>=99?'disabled':''}>+</button></div><p class="meta">${qty?`${qty} in your plan · `:''}Listed price · stock unverified</p><details><summary>Product source & category</summary><p><a href="${esc(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">View on Delio ↗</a></p><p>${p.classification?.status==='suggested'?'Jev category suggestion':'Category needs review'}. Coupon eligibility is not verified for this item.</p></details></article>`;
 }).join(''):'<p class="empty-plan">No groceries match this selection.</p>';
 $('products').querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>img.remove(),{once:true}));
 renderBasket();
}
function renderBasket(){
 const plan=planBasket({items:data.items,lines,regionId,indexRegionId:data.regionId});
 $('basket-count').textContent=lines.reduce((s,l)=>s+l.quantity,0);
 $('basket-lines').innerHTML=plan.lines.length?plan.lines.map(l=>{const note=notes.get(l.productId);return `<div class="draft-line${note?' noted':''}"><h3>${esc(l.title)}</h3><div><span class="stepper"><button data-delta="-1" data-id="${l.productId}" aria-label="Remove one ${esc(l.title)}">−</button>${l.quantity}<button data-delta="1" data-id="${l.productId}" aria-label="Add one ${esc(l.title)}" ${l.quantity>=99||note?.max===l.quantity?'disabled':''}>+</button></span><span>${esc(money(l.estimatedLineMinor))}</span></div>${note?`<span class="badge">${esc(note.text)}</span><button class="swap" data-swap="${l.productId}" title="Ask Jev for a substitute">✦ swap</button>`:''}</div>`;}).join(''):'<div class="empty-plan">A few everyday favourites.<br>A little less to think about.<br><br>Add a product to begin.</div>';
 const remaining=plan.remainingToReportedMinimumMinor;
 $('basket-summary').innerHTML=`<div class="subtotal"><span>Estimated items</span><span>${esc(money(plan.estimatedSubtotalMinor))}</span></div><div class="coupon-progress"><strong>${remaining===null?'Choose the indexed delivery area':remaining>0?`${esc(money(remaining))} to the 150 zł milestone`:'150 zł planning milestone reached'}</strong><progress value="${Math.min(15000,plan.estimatedSubtotalMinor||0)}" max="15000" aria-label="Estimated basket progress toward 150 zł"></progress><p>75 zł coupon available for an eligible first order. Delio must confirm qualifying items and activate it in the cart.</p><p>${remaining!==null&&remaining<=0&&Number.isSafeInteger(plan.estimatedSubtotalMinor)?`If Delio accepts the coupon, items come to about <strong>${esc(money(Math.max(0,plan.estimatedSubtotalMinor-7500)))}</strong> — verify for the exact total.`:'Discount is applied by Delio at checkout, not here.'} Delivery and fees not included.</p>${remaining>0?'<button id="topup" class="jev-hint">✦ Jev: fill the gap</button>':''}</div>`;
 $('save-plan').disabled=!lines.length||regionId!==data.regionId;$('clear-plan').disabled=!lines.length;$('verify-plan').disabled=!lines.length||regionId!==data.regionId;$('meal-plan').hidden=!lines.length;
}
function change(id,delta){if(!data||regionId!==data.regionId||!data.items.some(p=>p.productId===id))return;const next=lines.map(l=>({...l})),i=next.findIndex(l=>l.productId===id);if(i<0&&delta>0&&next.length<50)next.push({productId:id,quantity:1});else if(i>=0)next[i].quantity=Math.min(99,next[i].quantity+delta);lines=next.filter(l=>l.quantity>0);store();render();}
async function load(){
 const r=await fetch('/api/groceries',{cache:'no-store'});if(r.status===401){$('admission').hidden=false;$('notice').textContent='Open your local workspace to browse the account’s Kraków catalogue.';return;}
 if(!r.ok)throw new Error('The catalogue is not available yet.');data=await r.json();$('admission').hidden=true;restore();
 $('coupon-status').textContent=`Saved to this account · valid through ${data.promotion.validThroughLabel}. Activate in Delio’s cart.`;
 $('notice').textContent=`${data.items.length} groceries collected for Kraków. Build a plan below; no order is submitted.`;
 $('details').innerHTML=`<p>Code ${esc(data.promotion.code)} · ${esc(data.promotion.title)} · 75 zł off a qualifying first order from 150 zł · valid through ${esc(data.promotion.validThroughLabel)}. Merchant account terms observed ${esc(date(data.promotion.observedAt))}.</p><p>Excluded according to the coupon: alcohol other than beer, tobacco, medicinal products, and products for infants and children. Product-level eligibility and first-order status still require checkout verification. <a href="https://jush.pl/regulaminy/" target="_blank" rel="noopener noreferrer">Merchant regulations ↗</a></p><p>Coverage: ${data.items.length} unique products from ${data.coverage.pagesCollected} rendered page(s). This is a partial index. ${data.coverage.incompleteCards} truncated cards were omitted. The address was selected in the merchant browser; no delivery slot was reserved.</p><p>Jev categorization: ${data.measurement.totalAttempts} calls, estimated model cost $${Number(data.measurement.estimatedModelCostUsd||0).toFixed(6)}${data.measurement.estimatedModelCostUsd===null?' (exact cost unavailable)':''}. Browser infrastructure and manual work are not included.</p>`;
 render();
}
$('grocery-signin').addEventListener('submit',async e=>{e.preventDefault();const accessCode=$('grocery-code').value;$('grocery-code').value='';try{const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessCode})});if(!r.ok)throw new Error('Check the local workspace access code.');await load();}catch(err){$('notice').textContent=err.message;}});
$('search').addEventListener('input',e=>{query=e.target.value;intentItems=null;intentNote='';render();});
$('region').addEventListener('change',e=>{regionId=e.target.value;store();render();});
document.addEventListener('click',e=>{const button=e.target.closest('button');if(!button||button.disabled)return;
 if(button.hasAttribute('data-category')){category=button.dataset.category;render();}
 else if(button.dataset.add){change(button.dataset.add,1);}
 else if(button.dataset.delta)change(button.dataset.id,Number(button.dataset.delta));
 else if(button.id==='topup'){button.disabled=true;suggestZone('Asking Jev…',[]);
  askJev({kind:'topup'}).then(r=>suggestZone(r.suggestions?.length?'Jev suggests to reach the 150 zł milestone:':'Jev found no sensible top-up here.',r.suggestions||[])).catch(()=>suggestZone('Jev suggestions are unavailable right now.',[]));}
 else if(button.dataset.swap){const from=button.dataset.swap,title=lines.find(l=>l.productId===from)?.title||'that item';button.disabled=true;suggestZone('Asking Jev…',[]);
  askJev({kind:'substitute',productId:from}).then(r=>{const s=r.suggestions?.[0];
   suggestZone(s?`Jev’s swap for ${title}:`:`Jev found no good substitute for ${title}.`,r.suggestions||[],s?`<button class="primary" data-swapto="${s.productId}" data-swapfrom="${from}">Swap in ${esc(s.title)}</button>`:'');}).catch(()=>suggestZone('Jev suggestions are unavailable right now.',[]));}
 else if(button.dataset.swapto){const from=button.dataset.swapfrom,qty=lines.find(l=>l.productId===from)?.quantity||1;
  lines=lines.filter(l=>l.productId!==from);notes.delete(from);
  const ex=lines.find(l=>l.productId===button.dataset.swapto);
  if(ex)ex.quantity=Math.min(99,ex.quantity+qty);else lines.push({productId:button.dataset.swapto,quantity:qty});
  store();suggestZone('',[]);render();}});
$('clear-plan').addEventListener('click',()=>{lines=[];store();render();});
$('save-plan').addEventListener('click',()=>{const plan=planBasket({items:data.items,lines,regionId,indexRegionId:data.regionId});const file=new Blob([JSON.stringify({...plan,catalogueObservedAt:data.observedAt,couponCode:data.promotion.code,requiresFreshMerchantValidation:true},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(file);a.download='buena-krakow-basket-plan.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
// Push the local plan into the real Delio cart and read back a verified
// checkout quote. Multi-round reconcile because a long multi-line sync can
// span more than one bounded worker operation; each round is verified.
const post=(path,payload)=>fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}).then(r=>r.json());
// Jev suggestion strip — shared by top-up, meal and substitute results.
const suggestZone=(title,items,extra='')=>{$('suggest-zone').innerHTML=title?`<div class="jev-suggest"><p class="fine">${esc(title)}</p>${items.map(s=>{const img=productImageUrl(s);return `<div class="sug"><div class="g-photo sm">${img?`<img src="${esc(img)}" alt="" loading="lazy" decoding="async">`:''}</div><div class="sug-info"><span>${esc(s.title)}</span><em>${esc(s.packSize||'')} · ${esc(money(s.unitPriceMinor))}</em></div><button class="g-add" data-add="${s.productId}" aria-label="Add ${esc(s.title)} to basket plan">+</button></div>`;}).join('')}${extra}</div>`:'';};
const askJev=async body=>{const r=await post('/api/suggest',{...body,lines});return r&&r.ok!==false?r:{suggestions:[]};};
$('smart-search').addEventListener('click',async()=>{const b=$('smart-search');b.disabled=true;b.textContent='…';
 try{const r=await askJev({kind:'intent',query});
  intentItems=r.items?.length?r.items:null;
  intentNote=intentItems?`Jev read “${query}” as ${r.interpretation?.facet||r.interpretation?.category||'a browse'} — ${r.items.length} matches.`:`Jev couldn't map “${query}” to catalogue items — try different words.`;}catch{intentNote='Jev search is unavailable right now.';}
 b.disabled=false;b.textContent='✦';render();});
$('sort').addEventListener('change',e=>{sort=e.target.value;render();});
$('prefs').addEventListener('click',e=>{const b=e.target.closest('button[data-pref]');if(!b)return;pref=b.dataset.pref;$('prefs').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));render();});
$('meal-plan').addEventListener('click',async()=>{const b=$('meal-plan');b.disabled=true;suggestZone('Asking Jev…',[]);
 try{const r=await askJev({kind:'meal'});suggestZone(r.suggestions?.length?'Jev: completes what’s in your basket:':'Jev found nothing missing here.',r.suggestions||[]);}catch{suggestZone('Jev suggestions are unavailable right now.',[]);}
 b.disabled=false;});
const lineKey=ls=>(ls||[]).map(l=>`${l.productId}:${l.quantity}`).sort().join(',');
function renderQuote(q,adjusted=[],payment=null){
 const a=q.amounts,coupon=(q.couponResults||[]).find(c=>c.code===data.promotion.code);
 const short=(q.stockProof?.lines||[]).filter(l=>l.availableQuantity<l.quantity).length;
 const removed=adjusted.filter(x=>x.to===0),reduced=adjusted.filter(x=>x.to>0);
 $('verify-result').innerHTML=`<div class="verified-quote"><div class="total"><span>You pay at Delio</span><strong>${esc(money(a.merchantTotalMinor))}</strong></div>${coupon?.accepted?`<p class="win">75 zł coupon applied · ${esc(coupon.code)}</p>`:`<p class="fine">Coupon not applied${coupon?.reason?` — ${esc(coupon.reason)}`:''}.</p>`}<div class="subtotal"><span>Items (${(q.lines||[]).length})</span><span>${esc(money(a.itemSubtotalMinor))}</span></div><div class="subtotal"><span>Packing + delivery</span><span>${esc(money((a.serviceFeeMinor||0)+(a.deliveryFeeMinor||0)))}</span></div><div class="subtotal"><span>Discount</span><span>−${esc(money(a.discountMinor))}</span></div>${adjusted.length?`<p class="fine adj">${reduced.length?`${reduced.length} quantit${reduced.length===1?'y':'ies'} reduced to Delio's stock`:''}${reduced.length&&removed.length?' · ':''}${removed.length?`${removed.length} out-of-stock item${removed.length===1?'':'s'} removed`:''} — see the marked lines above.</p>`:''}<p class="fine">Verified live at Delio ${esc(date(q.observedAt))} · all ${(q.lines||[]).length} lines ${short?`(${short} short)`:'in stock'}. Nothing was ordered — checkout stays in your hands.</p>${q.status==='verified'?'<div id="pay-root"></div>':''}</div>`;
 // The devnet wallet island mounts only for a verified quote; it renders the
 // Privy connect → pay → confirm flow and never claims an order was placed.
 if(q.status==='verified')window.buenaPay?.show({container:$('pay-root'),quoteId:q.quoteId,version:q.version,totalMinor:a.totalMinor,currency:'PLN',payment});
}
const REASONS={product_unavailable:'out of stock at your store',stock_insufficient:'not enough stock for the planned quantity',quantity_capped:'merchant quantity limit reached',add_control_unverified:'add control not found on the page',add_click_failed:'add control would not click',add_effect_unverified:'cart count did not change after clicking',stepper_unverified:'quantity controls not found',stepper_click_failed:'quantity control would not click',adjust_effect_unverified:'quantity did not change after clicking',line_missing:'line not found in the cart'};
function blockerText(b,code){const title=data?.items?.find(p=>p.productId===b?.productId)?.title||b?.productId||'an item';const raw=String(b?.reason||code||'').replace(/^cart_/,'');const why=REASONS[raw.split(':')[0]]||raw.replace(/_/g,' ');return `${title}: ${why}`;}
const friendly=m=>{
 if(m==='worker_busy')return 'a sync was already running on the Delio browser — wait a minute, then verify again';
 if(m==='authentication_required'){$('admission').hidden=false;return 'your local session expired — re-enter the workspace access code above, then verify again';}
 return m;
};
// Merchant blockers that are facts about Delio's stock — the plan is corrected
// to them automatically. Anything else (a control that would not click) may be
// transient and is retried before the user is asked.
const DEFINITE=/^(product_unavailable|stock_insufficient|quantity_capped)/;
const titleOf=id=>data?.items?.find(p=>p.productId===id)?.title||id;
const noteFor=(reason,landedQty)=>{const r=String(reason||'');const cap=r.match(/^stock_insufficient:(\d+)/)?.[1];
 if(/^product_unavailable/.test(r)||landedQty===0)return {text:'Out of stock at Delio — removed',max:0};
 return {text:`Delio has ${cap??landedQty} in stock — adjusted`,max:Number(cap??landedQty)};};
$('verify-plan').addEventListener('click',async()=>{
 const btn=$('verify-plan');btn.disabled=true;const out=$('verify-result');const blockers=new Map();const selection=$('jev-mode')?.checked?'jev':undefined;
 const say=t=>{out.innerHTML=`<p class="muted">${esc(t)}</p>`;};
 const collect=res=>{if(res?.blocked?.productId)blockers.set(res.blocked.productId,res.blocked.reason||res.code);for(const b of res?.blockers||[])if(b?.productId)blockers.set(b.productId,b.reason||b.code);};
 notes.clear();
 const adjusted=[];
 // Correct the plan to Delio's facts and record a note on each affected line.
 const autoCorrect=landed=>{let changed=false;
  for(const l of lines){const have=landed.find(x=>x.productId===l.productId)?.quantity||0;if(have===l.quantity)continue;const reason=blockers.get(l.productId);if(!reason||!DEFINITE.test(reason))continue;
   const note=noteFor(reason,have);notes.set(l.productId,note);adjusted.push({productId:l.productId,from:l.quantity,to:have});l.quantity=have;changed=true;}
  if(changed){lines=lines.filter(l=>l.quantity>0);store();renderBasket();}return changed;};
 const wantedNow=()=>lines.map(l=>({productId:l.productId,quantity:l.quantity}));
 try{
  say('Checking your Delio cart…');
  let st=await (await fetch('/api/state',{cache:'no-store'})).json();
  if(st.authenticated===false)throw new Error('authentication_required');
  // A fresh observed cart skips the read round-trip; the worker re-reads
  // before mutating anyway, so nothing is trusted blindly.
  if(st.state?.cart?.status!=='observed'){st=await post('/api/reconcile',{});if(!st.ok)throw new Error(st.code||'reconcile_failed');}
  for(let round=0;round<4&&lineKey(st.state.cart.lines)!==lineKey(wantedNow());round++){
   say(`Syncing ${lines.length} items into your Delio cart… ${round?`round ${round+1}`:''}${selection==='jev'?' (Jev)':''}`);
   st=await post('/api/cart',{version:st.state.version,lines:wantedNow(),...(selection?{selection}:{})});
   collect(st);
   if(st.code==='basket_partial'){autoCorrect(st.state.cart.lines||[]);continue;}
   if(!st.ok){
    if(/worker_deadline|uncertain|worker_transport|cart_requires_reconciliation/.test(st.code||'')){
     const rc=await post('/api/reconcile',{});if(!rc.ok)throw new Error(rc.code||'reconcile_failed');st=rc;continue;
    }
    throw new Error(blockers.size?[...blockers.entries()].map(([id,r])=>blockerText({productId:id,reason:r})).join(' · '):st.code||'cart_update_failed');
   }
  }
  const landed=st.state.cart.lines||[];
  const missing=wantedNow().filter(w=>!landed.some(l=>l.productId===w.productId&&l.quantity===w.quantity));
  if(missing.length){
   // Not a stock fact — a control that would not respond. Offer the only two
   // honest moves: retry, or take the cart as it stands.
   for(const m of missing){const have=landed.find(l=>l.productId===m.productId)?.quantity||0;notes.set(m.productId,{text:`Could not sync (${have} of ${m.quantity} in cart) — retry`,max:null});}
   renderBasket();
   out.innerHTML=`<div class="verified-quote"><strong>${missing.length} item${missing.length===1?'':'s'} did not sync</strong><p class="fine">Delio did not respond for ${missing.map(m=>esc(titleOf(m.productId))).join(', ')}. This is usually temporary.</p><div class="actions"><button id="retry-verify" class="primary">Retry</button><button id="accept-landed" class="text-button">Use what is in the cart</button></div></div>`;
   $('retry-verify').addEventListener('click',()=>$('verify-plan').click());
   $('accept-landed').addEventListener('click',()=>{const ids=new Set(missing.map(m=>m.productId));lines=lines.map(l=>ids.has(l.productId)?{...l,quantity:landed.find(x=>x.productId===l.productId)?.quantity||0}:l).filter(l=>l.quantity>0);for(const id of ids)notes.delete(id);store();render();$('verify-plan').click();});
   return;
  }
  if(st.state.cart.status!=='observed'){const rc=await post('/api/reconcile',{});if(rc.ok)st=rc;}
  say('Activating the 75 zł coupon at Delio…');
  const c=await post('/api/apply-coupon',{version:st.state.version});
  if(c.ok)st=c;
  else{const rc=await post('/api/reconcile',{});if(rc.ok)st=rc;}
  say('Reading your exact checkout total…');
  const q=await post('/api/quote',{version:st.state.version});
  if(!q.ok||!q.state?.quote)throw new Error(q.code||'quote_failed');
  renderQuote(q.state.quote,adjusted,q.payment||null);
 }catch(e){say(`Stopped: ${friendly(e.message)}. Adjust the plan and retry — your Delio cart keeps what landed.`);}
 finally{btn.disabled=false;renderBasket();}
});
load().catch(()=>{$('notice').textContent='The local catalogue could not be loaded. No merchant action was taken.';});
