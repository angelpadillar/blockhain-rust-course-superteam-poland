import { McpClient, structured } from 'file:///app/delio/vendor/mcp.mjs';
import { startDisplay } from 'file:///app/delio/vendor/display.mjs';
import { writeFile } from 'node:fs/promises';
const root='/app/state';
const stop=await startDisplay();
const client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:25000});
const S={session_id:'delio-owner'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const path=process.env.PDP||'/products/A0001025-kajzerka';
try{
  await client.initialize();
  await client.call('session_create',{...S,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  await client.call('browser_navigate',{...S,require_existing:true,url:'https://delio.com.pl'+path,wait_until:'load',timeout_ms:15000});
  await sleep(2500);
  try{await client.call('browser_press_key',{...S,key:'Escape',selector:'body',timeout_ms:2000});}catch{}
  await sleep(800);
  const snap=structured(await client.call('browser_snapshot',{...S,max_elements:1000}));
  const els=snap.elements||[];
  // buy area: elements containing dodaj/koszyk/dostępn/cena
  els.filter(e=>/dodaj|koszyk|dostęp|niedostęp|zamów/i.test(String(e.name||''))).slice(0,15).forEach(e=>console.log(e.ref,e.role,JSON.stringify(String(e.name||'').slice(0,90))));
  const h1=els.find(e=>e.role==='heading');
  // get a focused snapshot around main content
  const raw=structured(await client.call('browser_get_content',{...S,selector:'main',format:'html',max_bytes:200000}));
  const mh=typeof raw.content==='string'?raw.content:'';
  console.log('main html len',mh.length);
  console.log('addToCart labels:',[...new Set([...mh.matchAll(/aria-label="([^"]{3,80})"/g)].map(m=>m[1]).filter(l=>/koszyk|dodaj/i.test(l)))]);
  console.log('unavailable?',/Chwilowo niedostępny|Brak towaru|Produkt niedostępny/.test(mh));
  const buy=mh.match(/<button[^>]{0,200}>(?:(?!<\/button>).){0,200}?(?:Dodaj|Do koszyka|koszyka)[\s\S]{0,80}?<\/button>/i);
  console.log('buy button:',buy?buy[0].replace(/\s+/g,' ').slice(0,300):'none');
  await writeFile('/app/state/pdp-main.html',mh,{mode:0o600});
}catch(e){console.log('FATAL',String(e).slice(0,300));}
finally{await client.close().catch(()=>{});if(stop)await stop().catch(()=>{});}
