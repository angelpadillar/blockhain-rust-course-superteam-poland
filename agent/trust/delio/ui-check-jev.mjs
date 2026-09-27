// Read-only DOM check of the Jev-powered UI surfaces: pref chips, sort,
// smart-search visibility, meal/top-up/swap affordances. No merchant calls.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const require=createRequire(join(here,'../../hackathon/jev/package.json'));
const {chromium}=require('playwright-core');
const accessCode=JSON.parse(readFileSync(join(here,'private/operator.json'),'utf8')).accessCode;
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage();
try{
 await page.goto('http://127.0.0.1:4319/groceries',{waitUntil:'domcontentloaded'});
 await page.waitForSelector('#admission:not([hidden])',{timeout:10000});
 await page.fill('#grocery-code',accessCode);
 await page.click('#grocery-signin button');
 await page.waitForSelector('.g-product',{timeout:15000});
 const r=await page.evaluate(async()=>{
  const prefs=[...document.querySelectorAll('#prefs button')].map(b=>b.dataset.pref);
  const tagged=document.querySelectorAll('.jev-tags').length;
  [...document.querySelectorAll('#prefs button')].find(b=>b.dataset.pref==='kidFriendly').click();
  const kidsCount=document.querySelectorAll('.g-product').length;
  [...document.querySelectorAll('#prefs button')].find(b=>b.dataset.pref==='').click();
  document.getElementById('sort').value='staple';document.getElementById('sort').dispatchEvent(new Event('change'));
  const firstTitle=document.querySelector('.g-product h3')?.textContent;
  const s=document.getElementById('search');s.value='obiad';s.dispatchEvent(new Event('input'));
  const smartVisible=!document.getElementById('smart-search').hidden;
  const mealHidden0=document.getElementById('meal-plan').hidden;
  const add=document.querySelector('.g-product .g-add');add.click();
  document.querySelectorAll('.g-product .g-add')[1]?.click();
  const mealHidden2=document.getElementById('meal-plan').hidden;
  const topupBtn=!!document.getElementById('topup');
  return{prefs,tagged,kidsCount,firstTitle,smartVisible,mealHidden0,mealHidden2,topupBtn};
 });
 console.log(JSON.stringify(r,null,1));
 // Live smart-search click → Jev intent
 await page.click('#smart-search');
 await page.waitForSelector('#search-note:not([hidden])',{timeout:20000});
 const intent=await page.evaluate(()=>({note:document.getElementById('search-note').textContent,count:document.querySelectorAll('.g-product').length}));
 console.log('INTENT:',JSON.stringify(intent));
 // Live top-up click → Jev suggestions strip
 await page.evaluate(()=>{document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'));});
 await page.click('#topup');
 await page.waitForSelector('.jev-suggest .sug, .jev-suggest .fine',{timeout:20000});
 const topup=await page.evaluate(()=>({title:document.querySelector('.jev-suggest .fine')?.textContent,items:[...document.querySelectorAll('.sug-info span')].map(x=>x.textContent)}));
 console.log('TOPUP:',JSON.stringify(topup));
 // Live meal click
 await page.click('#meal-plan');
 await page.waitForSelector('.jev-suggest',{timeout:20000});
 const meal=await page.evaluate(()=>({title:document.querySelector('.jev-suggest .fine')?.textContent,items:[...document.querySelectorAll('.sug-info span')].map(x=>x.textContent)}));
 console.log('MEAL:',JSON.stringify(meal));
 writeFileSync(join(here,'evidence/groceries-jev-ui-check.json'),JSON.stringify({...r,intent,topup,meal},null,2));
}finally{await browser.close();}
