import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const adapter = resolve(process.env.JEV_ADAPTER_DIR || (existsSync(join(root, 'hackathon/jev/package.json')) ? join(root, 'hackathon/jev') : root));
const upstreamRoot = resolve(process.env.JEV_ULTRAFAST_DIR || join(root, 'research/jev-ultrafast'));
const { chromium } = await import(pathToFileURL(join(adapter, 'node_modules/playwright-core/index.mjs')));
const { readNavigationDom, navigationActions } = await import(pathToFileURL(join(adapter, 'src/navigation.mjs')));
const task = JSON.parse(await readFile(join(adapter, 'cases/foczka-navigation.json')));
const upstream = await readFile(join(upstreamRoot, 'jev_ultrafast/snapshot.js'), 'utf8');
const targetStore = new URL(task.targetUrl).origin + new URL(task.targetUrl).pathname;
const fixtures = [
 {id:'semantic-product-button', expected:task.product, html:`<button onclick="window.opened=true">${task.product}</button>`},
 {id:'glovo-product-tile', expected:task.product, html:`<div class="ItemTile_itemTile__fixture" onclick="window.opened=true"><img alt="${task.product}"><h3>${task.product}</h3><button aria-label="Increase quantity">+</button></div>`},
 {id:'glovo-search-result-row', expected:task.product, html:`<div class="ItemRow_itemRow__fixture" onclick="window.opened=true"><img alt="${task.product}"><p>${task.product}</p><button aria-label="Increase quantity">+</button></div>`},
 {id:'glovo-category-heading', expected:'Rum i gin', html:'<div class="StoreMenuItem_listItem__fixture" onclick="window.opened=true"><h3>Rum i gin</h3></div>'},
];
const browser = await chromium.launch({channel:'chrome',headless:true,chromiumSandbox:true});
const results=[];
try {
 const page=await browser.newPage({viewport:{width:1120,height:780}});
 for(const fixture of fixtures){
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><style>body{padding:20px}h3,p,button{padding:12px}</style>'+fixture.html}));
  await page.goto(targetStore);
  for(let i=0;i<5;i++){await page.evaluate(upstream);await page.locator('body').evaluate(readNavigationDom);}
  const timings={ultrafast:[],current_adapter:[]}; let fast,old;
  for(let i=0;i<60;i++){
   for(const kind of i%2?['current_adapter','ultrafast']:['ultrafast','current_adapter']){
    const start=performance.now();
    if(kind==='ultrafast')fast=await page.evaluate(upstream);else old=await page.locator('body').evaluate(readNavigationDom);
    timings[kind].push(performance.now()-start);
   }
  }
  const oldActions=navigationActions({...old,url:targetStore},task);
  const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
  results.push({fixture:fixture.id,expected:fixture.expected,
   ultrafast:{targetOffered:fast.actions.some(a=>a.label===fixture.expected&&a.kind==='click'),actions:fast.actions.map(a=>({kind:a.kind,label:a.label})),medianReadMs:median(timings.ultrafast)},
   currentAdapter:{targetOffered:oldActions.some(a=>a.control.label===fixture.expected&&a.kind==='click'),actions:oldActions.map(a=>({kind:a.kind,label:a.control.label})),medianReadMs:median(timings.current_adapter)},
   samplesPerReader:60});
  await page.unroute('**/*');
 }
}finally{await browser.close();}
const report={capturedAt:new Date().toISOString(),upstreamCommit:'452c1ad2dd628008f1d5608f28158d76e49e6cc0',
 scope:'Controlled DOM fixtures based on previously observed markup. No model calls, no live Glovo interaction, no end-to-end speed claim. Timing includes Playwright evaluate transport; stock Browser Harness transport is not measured.',results};
await mkdir(new URL('./results/',import.meta.url),{recursive:true});
await writeFile(new URL('./results/reader-comparison.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
