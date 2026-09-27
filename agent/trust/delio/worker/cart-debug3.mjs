import { McpClient, structured } from 'file:///app/delio/vendor/mcp.mjs';
import { startDisplay } from 'file:///app/delio/vendor/display.mjs';
const root='/app/state';
const stop=await startDisplay();
const client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:25000});
const S={session_id:'delio-owner'};
const snap=async(io=true)=>structured(await client.call('browser_snapshot',{...S,max_elements:1000,interactive_only:io}));
const drawer=async()=>{try{const r=structured(await client.call('browser_get_content',{...S,selector:'[role="dialog"]',format:'html',max_bytes:262144}));const h=typeof r.content==='string'?r.content:'';return /Twój koszyk|Usuń z koszyka/i.test(h)?h.length:0;}catch{return 0;}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  await client.initialize();
  await client.call('session_create',{...S,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  await client.call('browser_navigate',{...S,require_existing:true,url:'https://delio.com.pl/products/A0000953-maslo-polskie-extra',wait_until:'load',timeout_ms:15000});
  await sleep(1500);
  const s1=await snap(true);
  const entry=s1.elements.find(e=>e.role==='button'&&/^Twój koszyk/.test(e.name||''));
  console.log('entry',JSON.stringify(entry));
  // interleave get_content calls (like drawerHtml probes) between snapshot and click
  for(const sel of ['[data-radix-dialog-content]','[data-vaul-drawer]','div[data-focus-anchor="cart"]']){
    try{await client.call('browser_get_content',{...S,selector:sel,format:'html',max_bytes:8192});}catch{}
  }
  await client.call('browser_click',{...S,ref:entry.ref,timeout_ms:4000}).then(()=>console.log('stale-ref click ok')).catch(e=>console.log('stale-ref click ERR',String(e).slice(0,90)));
  await sleep(1200);
  console.log('drawer after stale-ref click:',await drawer());
}catch(e){console.log('FAIL',String(e).slice(0,200));}
finally{try{await client.call('session_destroy',{...S},{timeoutMs:4000});}catch{}await client.close();stop?.();}
