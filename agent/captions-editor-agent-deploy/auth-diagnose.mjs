import fs from 'node:fs/promises';
import {openBrowser} from '/app/src/browser.mjs';
const config=JSON.parse(await fs.readFile('/app/config/editor.json','utf8'));
config.onboardingDomains=['api.workos.com','auth.mirage.app'];config.interactiveAuthDomains=config.onboardingDomains;config.resourceDomains.push('workos.imgix.net');
config.mutationRoutes=[{host:'as.captions.ai',path:'/v1/initialize',methods:['POST'],contentTypes:['application/json','text/plain','text/plain;charset=utf-8'],phase:'read'}];
const dir='/app/data/auth-diagnostic';await fs.mkdir(dir,{recursive:true,mode:0o700});
const blocked=[];const session=await openBrowser(config,dir,{desktop:true,onBlocked:x=>blocked.push(x)});
try{
 await session.page.goto('https://captions.ai/home',{waitUntil:'domcontentloaded'});
 await new Promise(r=>setTimeout(r,15000));
 const controls=await session.page.locator('button,a').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,text:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||'').trim().slice(0,100),href:e.tagName==='A'?e.getAttribute('href'):null})));
 const signup=controls.find(c=>c.text==='Sign up'&&c.href==='/signup');
 if(signup){await session.page.getByRole('link',{name:'Sign up',exact:true}).click().catch(()=>{});await new Promise(r=>setTimeout(r,5000));}
 const pages=[];for(const p of session.context.pages()){const u=new URL(p.url());pages.push({url:u.origin+u.pathname,text:await p.locator('body').innerText().then(s=>s.slice(0,1800)).catch(()=>''),controls:await p.locator('button,a,input').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({tag:e.tagName,type:e.type,text:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||'').trim().slice(0,100)}))).catch(()=>[])});}
 pages.forEach(p=>p.controls=p.controls.slice(0,15));console.log(JSON.stringify({pages,blocked:blocked.filter(x=>!/(litix|datadog|rgstr|facebook|googletag|mux|analytics|beacon|oaiq|stripe|statsig)/.test(x.url))},null,2));
 await session.page.screenshot({path:dir+'/home.png'});
}finally{await session.close();}
