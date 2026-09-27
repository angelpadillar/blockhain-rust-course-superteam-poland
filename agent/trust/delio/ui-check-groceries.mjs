// Read-only DOM check of the local /groceries planner. No merchant call is made:
// basket edits stay in browser localStorage; the only network is the local server.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(join(here,'../../hackathon/jev/package.json'));
const {chromium}=require('playwright-core');
const accessCode=JSON.parse(readFileSync(join(here,'private/operator.json'),'utf8')).accessCode;
const browser=await chromium.launch({channel:'chrome',headless:true});
const started=performance.now();
try{
 const page=await browser.newPage();
 const requests=[];
 page.on('request',r=>{const u=new URL(r.url());if(u.origin!=='http://127.0.0.1:4319'&&u.origin!=='https://delio.com.pl')requests.push(u.origin);});
 await page.goto('http://127.0.0.1:4319/groceries',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('#admission:not([hidden])',{timeout:10000});
 await page.fill('#grocery-code',accessCode);
 await page.click('#grocery-signin button');
 await page.waitForSelector('.g-product',{timeout:15000});
 const summary=await page.evaluate(()=>({
  productCards:document.querySelectorAll('.g-product').length,
  categoryButtons:[...document.querySelectorAll('#categories button')].map(b=>b.textContent),
  notice:document.getElementById('notice').textContent,
  couponStatus:document.getElementById('coupon-status').textContent,
  freshness:document.getElementById('freshness').textContent,
  savePlanDisabled:document.getElementById('save-plan').disabled,
  admissionHidden:document.getElementById('admission').hidden,
 }));
 // Search: Polish diacritics must fold ("maslo" matches "Masło").
 await page.fill('#search','maslo');
 await page.waitForFunction(()=>document.querySelectorAll('.g-product').length>0&&document.querySelectorAll('.g-product').length<120,{timeout:5000});
 const search=await page.evaluate(()=>({count:document.querySelectorAll('.g-product').length,titles:[...document.querySelectorAll('.g-product h3')].slice(0,5).map(h=>h.textContent)}));
 await page.fill('#search','');
 // Category filter: pick a non-empty department button.
 const category=await page.evaluate(()=>{
  const b=[...document.querySelectorAll('#categories button')].find(x=>x.dataset.category==='bakery');b.click();
  return {label:b.textContent,count:document.querySelectorAll('.g-product').length};
 });
 await page.evaluate(()=>{[...document.querySelectorAll('#categories button')].find(x=>x.dataset.category==='').click();});
 // Basket: add two items, check stepper and progress copy.
 await page.click('.g-product .g-add');
 const basket=await page.evaluate(()=>{
  const add=document.querySelector('.g-product .g-add');add.click();add.click();
  return {count:document.getElementById('basket-count').textContent,lines:document.querySelectorAll('.draft-line').length,progress:document.querySelector('.coupon-progress strong').textContent,saveDisabled:document.getElementById('save-plan').disabled};
 });
 const stepper=await page.evaluate(()=>{
  document.querySelector('.draft-line [data-delta="-1"]').click();
  return {count:document.getElementById('basket-count').textContent,progress:document.querySelector('.coupon-progress strong').textContent};
 });
 // Region switch: Warsaw is unindexed; products and draft total must clear.
 await page.selectOption('#region','warsaw');
 const warsaw=await page.evaluate(()=>({products:document.querySelectorAll('.g-product').length,freshness:document.getElementById('freshness').textContent,saveDisabled:document.getElementById('save-plan').disabled}));
 await page.selectOption('#region','krakow');
 // Image: confirm at least one rendered photo through the CSP-allowed route.
 const image=await page.evaluate(async()=>{
  const img=document.querySelector('.g-product img');if(!img)return{present:false};
  if(!img.complete)await new Promise(r=>{img.addEventListener('load',r,{once:true});img.addEventListener('error',r,{once:true});setTimeout(r,8000);});
  return{present:true,loaded:img.complete&&img.naturalWidth>0,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,srcHost:new URL(img.src).host};
 });
 const receipt={observedAt:new Date().toISOString(),origin:'http://127.0.0.1:4319',page:'/groceries',controllerMs:Math.round(performance.now()-started),operatorAdmission:summary.admissionHidden,
  catalogue:{renderedCards:summary.productCards,categoryButtons:summary.categoryButtons,notice:summary.notice,freshness:summary.freshness},
  coupon:{statusLine:summary.couponStatus,appliedToDraft:0,merchantAccepted:false},
  search:{query:'maslo',resultCount:search.count,firstTitles:search.titles},
  categoryFilter:{category:category.label,resultCount:category.count},
  basketDraft:{afterThreeAdds:{count:basket.count,lines:basket.lines,progress:basket.progress,saveEnabled:!basket.saveDisabled},afterOneRemove:{count:stepper.count,progress:stepper.progress},merchantOrderSubmitted:false,storage:'browser-local draft only'},
  regionSwitch:{warsawProducts:warsaw.products,warsawFreshness:warsaw.freshness,krakowPricesCarryOver:false},
  renderedPhoto:image,unexpectedExternalOrigins:[...new Set(requests)]};
 writeFileSync(join(here,'evidence/groceries-ui-check.json'),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt,null,2));
}finally{await browser.close();}
