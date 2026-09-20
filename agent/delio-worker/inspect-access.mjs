import { readFile, writeFile } from 'node:fs/promises';
import { McpClient, structured, pngBytes } from './vendor/mcp.mjs';
import { startDisplay } from './vendor/display.mjs';
import { acquireOwner } from './vendor/lock.mjs';
process.umask(0o077);
const root='/app/state', session_id='delio-owner', started=performance.now();
const release=await acquireOwner(root);
let stopDisplay,client;
try {
  stopDisplay=await startDisplay();
  client=new McpClient(['mcp','--transport','stdio','--toolset','core','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:20000});
  await client.initialize();
  await client.call('session_create',{session_id,headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  await client.call('browser_navigate',{session_id,require_existing:true,url:'https://delio.com.pl/',wait_until:'load',timeout_ms:18000});
  let snapshot=structured(await client.call('browser_snapshot',{session_id,max_elements:1000,interactive_only:true}));
  const matches=snapshot.elements.filter(item=>item.role==='button' && /^Podaj adres dostawy\s+i rozpocznij zakupy$/.test(item.name));
  if(matches.length!==1)throw new Error('address_control_ambiguous');
  await client.call('browser_click',{session_id,ref:matches[0].ref,timeout_ms:4000});
  for(let scan=0;scan<8;scan++){
    snapshot=structured(await client.call('browser_snapshot',{session_id,max_elements:1000,interactive_only:true}));
    if(snapshot.elements.some(item=>['textbox','combobox'].includes(item.role) && item.name!=='Szukaj produktów'))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(process.argv.includes('--address')){
    const config=JSON.parse(await readFile('/app/config/worker.json','utf8'));
    const inputs=snapshot.elements.filter(item=>item.role==='textbox' && item.name==='Wpisz nazwę ulicy i numer budynku');
    if(inputs.length!==1)throw new Error('address_input_unverified');
    await client.call('browser_type',{session_id,ref:inputs[0].ref,text:config.deliveryQuery,clear_first:true,press_enter_after:false,timeout_ms:4000});
    const normalize=text=>String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').toLowerCase();
    const matching=item=>normalize(item.name).includes(normalize(config.expectedStreet)) && normalize(item.name).includes(normalize(config.expectedCity)) && new RegExp(`\\b${config.expectedBuilding}\\b`).test(item.name);
    for(let scan=0;scan<12;scan++){
      snapshot=structured(await client.call('browser_snapshot',{session_id,max_elements:1000,interactive_only:true}));
      if(snapshot.elements.some(item=>matching(item)&&item.role!=='textbox'))break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    await writeFile(`${root}/private-address-screen.png`,pngBytes(await client.call('browser_screenshot',{session_id,full_page:false,max_bytes:2097152})),{mode:0o600});
    await writeFile(`${root}/private-address-suggestions.json`,JSON.stringify(snapshot,null,2),{mode:0o600});
    const networkTool=client.tools.find(tool=>tool.name==='browser_network_requests');
    const hosts=new Map();
    if(networkTool){
      const network=structured(await client.call('browser_network_requests',{session_id}));
      const walk=value=>{if(!value||typeof value!=='object')return;if(typeof value.url==='string'){try{const host=new URL(value.url).hostname;const previous=hosts.get(host)||{host,requests:0,failed:0,statuses:[]};previous.requests++;if(value.failed||value.failure||value.error)previous.failed++;if(Number.isInteger(value.status)&&!previous.statuses.includes(value.status))previous.statuses.push(value.status);hosts.set(host,previous);}catch{}}for(const child of Object.values(value))if(child&&typeof child==='object')walk(child);};walk(network);
    }
    console.log(JSON.stringify({diagnostic:'network_host_counts',available:Boolean(networkTool),hosts:[...hosts.values()]}));
    const matches=snapshot.elements.filter(item=>matching(item)&&item.role!=='textbox').map(item=>({role:item.role,ref:item.ref,addressMatches:true,postalMatches:item.name.includes(config.expectedPostalCode),disabled:item.disabled===true}));
    console.log(JSON.stringify({ok:true,stage:'address_suggestions',browserRuntimeMs:Math.round(performance.now()-started),matches,controls:snapshot.elements.filter(item=>['button','textbox','combobox','option','dialog','heading'].includes(item.role)).slice(-35).map(item=>({role:item.role,ref:item.ref,name:matching(item)?'[private address]':[config.expectedStreet,config.expectedCity,config.expectedPostalCode].some(value=>normalize(item.name).includes(normalize(value)))?'[private address context]':item.name}))}));
    process.exitCode=0;
  }else{
  await writeFile(`${root}/address-dialog-snapshot.json`,JSON.stringify(snapshot,null,2),{mode:0o600});
  console.log(JSON.stringify({ok:true,browserRuntimeMs:Math.round(performance.now()-started),snapshot:{url:snapshot.url,elements:snapshot.elements.filter(item=>['textbox','button','heading','dialog','combobox','option','checkbox','radio'].includes(item.role))}}));
  }
}catch(error){console.log(JSON.stringify({ok:false,code:'access_inspection_failed',failure:error.browserFailure || null,browserRuntimeMs:Math.round(performance.now()-started)}));process.exitCode=1;}
finally{if(client){try{await client.call('session_destroy',{session_id},{timeoutMs:4000});}catch{}await client.close();}stopDisplay?.();await release();}
