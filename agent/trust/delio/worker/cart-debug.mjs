import { McpClient, structured } from 'file:///app/delio/vendor/mcp.mjs';
import { startDisplay } from 'file:///app/delio/vendor/display.mjs';
import { writeFile } from 'node:fs/promises';
const root='/app/state';
const stop=await startDisplay();
const client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:25000});
const S={session_id:'delio-owner'};
const snap=async(io=true)=>structured(await client.call('browser_snapshot',{...S,max_elements:1000,interactive_only:io}));
const drawer=async()=>{try{const r=structured(await client.call('browser_get_content',{...S,selector:'[role="dialog"]',format:'html',max_bytes:262144}));const h=typeof r.content==='string'?r.content:'';return /Twój koszyk|Usuń z koszyka/i.test(h)?h:'';}catch{return '';}};
const expanded=async()=>{try{const r=await client.call('browser_get_content',{...S,selector:'[data-testid="cart-button"]',format:'html',max_bytes:8192});return /aria-expanded="true"/.test(JSON.stringify(structured(r)||r));}catch(e){return 'err';}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  await client.initialize();
  await client.call('session_create',{...S,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  await client.call('browser_navigate',{...S,require_existing:true,url:'https://delio.com.pl/',wait_until:'load',timeout_ms:15000});
  // replicate op view(): interactive snap, full snap, full html
  const s1=await snap(true); const sF=await snap(false);
  const raw=structured(await client.call('browser_get_content',{...S,format:'html',max_bytes:524288}));
  const html=typeof raw.content==='string'?raw.content:'';
  await writeFile('/app/state/home-live.html',html,{mode:0o600});
  const entry=s1.elements.find(e=>e.role==='button'&&/^Twój koszyk/.test(e.name||''));
  console.log('els',s1.elements.length,'full',sF.elements.length,'entry',JSON.stringify(entry),'drawerPre',(await drawer()).length,'expandedPre',await expanded());
  // click attempts with diagnostics
  for(let c=0;c<3;c++){
    await sleep(900);
    await client.call('browser_click',{...S,ref:entry.ref,timeout_ms:4000}).then(()=>console.log('click',c,'ok')).catch(e=>console.log('click',c,'ERR',String(e).slice(0,90)));
    await sleep(700);
    console.log(' after',c,'drawerLen',(await drawer()).length,'expanded',await expanded());
    if((await drawer()).length)break;
  }
  // find a full-cart route: links/buttons that look like a cart page
  const links=[...new Set(sF.elements.filter(e=>e.role==='link').map(e=>String(e.href||'')))].filter(h=>/koszyk|cart|basket/i.test(h));
  console.log('cartLinks',JSON.stringify(links));
}catch(e){console.log('FAIL',String(e).slice(0,200));}
finally{try{await client.call('session_destroy',{...S},{timeoutMs:4000});}catch{}await client.close();stop?.();}
