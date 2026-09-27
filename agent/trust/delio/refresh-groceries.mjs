import {readFileSync,writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
import {remoteWorker} from './adapter.mjs';import {classifyCatalogue,TAXONOMY} from './catalogue-classifier.mjs';
const here=dirname(fileURLToPath(import.meta.url));process.umask(0o077);
// One owner, a bounded walk of the merchant's own category tree. Every path
// must have been observed as a link on a previously read page (the worker
// enforces the same allowlist). Never clicks Add, Checkout or Buy.
const PAGE_LIMIT=48,PRODUCT_LIMIT=1200,ATTEMPTS=join(here,'catalogue/collection-attempts.jsonl');
mkdirSync(join(here,'catalogue/pages'),{recursive:true});
const slug=p=>p==='/'?'home':p.replace(/\//g,'_').replace(/^_/,'');
const pages=[],queue=['/'],seen=new Set(queue);
while(queue.length&&pages.length<PAGE_LIMIT){
 const path=queue.shift(),started=performance.now();let r;
 try{r=await remoteWorker({operation:'readCatalogue',path});}catch{r={ok:false,code:'worker_transport_unavailable'};}
 appendFileSync(ATTEMPTS,JSON.stringify({at:Date.now(),sourcePath:path,ok:r.ok,code:r.code||null,controllerMs:Math.round(performance.now()-started),browserRuntimeMs:r.result?.browserRuntimeMs??null})+'\n');
 writeFileSync(join(here,'catalogue/pages',slug(path)+'.json'),JSON.stringify(r,null,2));
 if(path==='/'&&(!r.ok||!r.result.addressHeaderMatched||r.result.regionId!=='krakow'))throw new Error('confirmed_krakow_snapshot_required');
 if(!r.ok||!r.result?.addressHeaderMatched||r.result.regionId!=='krakow')continue;
 pages.push(r.result);
 for(const link of r.result.links||[])if(!seen.has(link.path)){seen.add(link.path);queue.push(link.path);}
 // Real aisles and their subcategories before promo pages, shallow first —
 // aisle parents are curated slices; the subcategory pages carry inventory.
 queue.sort((a,b)=>(a.includes('/promocje')?1:0)-(b.includes('/promocje')?1:0)||a.split('/').length-b.split('/').length);
}
const unique=new Map();for(const page of pages)for(const p of page.items)if(!unique.has(p.productId))unique.set(p.productId,{...p,listingObservedAt:page.observedAt,listingSourceUrl:page.sourceUrl,listingRegionId:'krakow'});
const raw=[...unique.values()].slice(0,PRODUCT_LIMIT);
const {items,measurement}=await classifyCatalogue({items:raw,apiKey:readFileSync(join(here,'private/typesafe-key.txt'),'utf8').trim(),storeDir:join(here,'private/grocery-classifier'),maxCalls:60});
const proof=JSON.parse(readFileSync(join(here,'evidence/grocery-coupon-details-observation.json'))).result;
const result={schemaVersion:1,regionId:'krakow',regionLabel:'Kraków',observedAt:Math.max(...pages.map(p=>p.observedAt)),collectedFromOwnedSession:true,addressHeaderMatched:true,stockVerified:false,deliverySlotSelected:false,checkoutVerified:false,
 promotion:{code:'z5913',title:'Witaj w delio!',status:'added_to_account_observed',advertisedDiscountMinor:7500,minimumBasketMinor:15000,firstOrderOnly:true,validThroughDate:'2026-09-30',validThroughLabel:'30 September 2026',expiryTimeUnspecified:true,observedAt:proof.observedAt,appliedToBasket:false,exclusions:['alcohol_except_beer','tobacco','medicinal_products','infant_and_children_products'],evidenceRefs:proof.artifacts,termsUrl:'https://jush.pl/regulaminy/'},
 coverage:{completeInventory:false,pagesCollected:pages.length,sourceUrls:pages.map(p=>p.sourceUrl),distinctProductsObserved:unique.size,productsPublished:items.length,incompleteCards:pages.reduce((s,p)=>s+p.incompleteCards,0),collectionLimit:PRODUCT_LIMIT,pageLimit:PAGE_LIMIT,conflictingProducts:pages.reduce((s,p)=>s+p.conflictingProducts,0)},
 categories:Object.entries(TAXONOMY).filter(([id])=>items.some(p=>p.categoryId===id)).map(([id,label])=>({id,label:id==='other'?'Needs review':label})),items,measurement,evidenceRefs:pages.flatMap(p=>p.artifacts)};
writeFileSync(join(here,'catalogue/krakow.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({products:items.length,distinct:unique.size,pages:pages.length,categories:result.categories.map(c=>c.id),modelCalls:measurement.totalAttempts,estimatedModelCostUsd:measurement.estimatedModelCostUsd,classificationsNeedingReview:items.filter(p=>p.classification.status!=='suggested').length}));
