import { McpClient, structured } from 'file:///app/delio/vendor/mcp.mjs';
import { startDisplay } from 'file:///app/delio/vendor/display.mjs';
import { writeFile } from 'node:fs/promises';
const root='/app/state';
const stop=await startDisplay();
const client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:25000});
const S={session_id:'delio-owner'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  await client.initialize();
  await client.call('session_create',{...S,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  await client.call('browser_navigate',{...S,require_existing:true,url:'https://delio.com.pl/cart',wait_until:'load',timeout_ms:15000});
  await sleep(2500);
  const r=await client.call('browser_click',{...S,selector:'main button:has-text("Przejdź do zamówienia")',timeout_ms:6000}).then(()=> 'ok').catch(e=>'ERR '+String(e).slice(0,200));
  console.log('checkout click:',r);
  await sleep(3500);
  const snap=structured(await client.call('browser_snapshot',{...S,max_elements:1000}));
  const s=JSON.stringify(snap);
  const urlm=s.match(/Page URL: (\S+)/)||s.match(/"url":\s*"([^"]+)"/);
  console.log('URL:',urlm?.[1]);
  const els=(snap.elements||[]).filter(e=>/zamówieni|kasa|kupon|rabat|razem|zapłać|dostaw|adres|termin|płac/i.test(String(e.name||'')));
  els.slice(0,30).forEach(e=>console.log(e.ref,e.role,JSON.stringify(String(e.name||'').slice(0,90))));
  const raw=structured(await client.call('browser_get_content',{...S,format:'html',max_bytes:524288}));
  await writeFile('/app/state/checkout.html',typeof raw.content==='string'?raw.content:'',{mode:0o600});
}catch(e){console.log('FATAL',String(e).slice(0,300));}
finally{await client.close().catch(()=>{});if(stop)await stop().catch(()=>{});}
