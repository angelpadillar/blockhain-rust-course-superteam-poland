import { McpClient, structured } from 'file:///app/delio/vendor/mcp.mjs';
import { startDisplay } from 'file:///app/delio/vendor/display.mjs';
const root='/app/state';
const stop=await startDisplay();
const client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:25000});
const S={session_id:'delio-owner'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
try{
  await client.initialize();
  await client.call('session_create',{...S,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  await client.call('browser_navigate',{...S,url:'https://delio.com.pl/cart',wait_until:'load',timeout_ms:15000});
  await sleep(1500);
  // probe coupon entry on /cart
  for(const sel of ['button:has-text("Dodaj kod rabatowy"):visible','button:has-text("Dodaj kod rabatowy")','button:has-text("Dodaj kod rabatowy") >> nth=0']){
    const t=Date.now();
    await client.call('browser_click',{...S,selector:sel,timeout_ms:4000}).then(()=>console.log('CLICK-OK',sel,Date.now()-t+'ms')).catch(e=>console.log('CLICK-ERR',sel,String(e).slice(0,110)));
    if(Date.now()-t<4500){await sleep(800);break;}
  }
  await sleep(1000);
  const s=await snap2();
  console.log('after click url:',s.url);
  const dia=(s.elements||[]).filter(e=>/kod|kupon|rabat|zamknij|aktywuj/i.test(String(e.name||'')));
  console.log('dialog-ish elements:',JSON.stringify(dia.map(e=>({r:e.role,n:String(e.name||'').slice(0,60),ref:e.ref}))));
  async function snap2(){return structured(await client.call('browser_snapshot',{...S,max_elements:1000,interactive_only:true}));}
}catch(e){console.log('FAIL',String(e).slice(0,300));}
finally{try{await client.call('session_destroy',{...S},{timeoutMs:4000});}catch{}await client.close();stop?.();}
