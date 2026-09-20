import {readFile,writeFile} from 'node:fs/promises';
import {McpClient,structured} from './vendor/mcp.mjs';
import {startDisplay} from './vendor/display.mjs';
import {acquireOwner} from './vendor/lock.mjs';
process.umask(0o077);
const ROOT='/app/state',session_id=process.argv.includes('--owner-profile')?'delio-owner':'delio-diagnostic',started=performance.now();
const config=JSON.parse(await readFile('/app/config/worker.json','utf8'));
const allowedHosts=['delio.com.pl',...(Array.isArray(config.reviewedMapHosts)?config.reviewedMapHosts:[])];
if(allowedHosts.some(host=>!['delio.com.pl','maps.googleapis.com','maps.gstatic.com'].includes(host)))throw new Error('Unreviewed diagnostic host');
const release=await acquireOwner(ROOT);
let client,stopDisplay,stage='startup';
const hosts=new Map();
async function network(){
  const data=structured(await client.call('browser_network_requests',{session_id,max_events:200,clear:false}));
  for(const event of Array.isArray(data.requests)?data.requests:[]){
    let hostname;try{hostname=new URL(event.url).hostname;}catch{continue;}
    const kind=['request','response','request_failed'].includes(event.event)?event.event:'unknown';
    const status=Number.isInteger(event.status)?event.status:null;
    const key=JSON.stringify([hostname,kind,status]);const entry=hosts.get(key)||{hostname,event:kind,status,count:0};entry.count++;hosts.set(key,entry);
  }
}
function content(payload){return typeof payload.content==='string'?payload.content:typeof payload.text==='string'?payload.text:typeof payload.html==='string'?payload.html:'';}
let result;
try{
  stopDisplay=await startDisplay();
  client=new McpClient(['mcp','--transport','stdio','--toolset','full','--session-dir',ROOT,'--allowed-hosts',allowedHosts.join(','),'--max-sessions','1','--session-ttl','10m'],{timeoutMs:20000});
  await client.initialize();await client.call('session_create',{session_id,headful:true,width:1360,height:900,profile_path:session_id,reuse_if_exists:true});
  stage='homepage';await client.call('browser_navigate',{session_id,require_existing:true,url:'https://delio.com.pl/',wait_until:'load',timeout_ms:18000});await network();
  stage='address_dialog';
  const snapshot=structured(await client.call('browser_snapshot',{session_id,max_elements:1000,interactive_only:true}));
  const buttons=snapshot.elements.filter(item=>item.role==='button'&&/^Podaj adres dostawy\s+i rozpocznij zakupy$/.test(item.name));
  if(buttons.length!==1)throw new Error('address_control_unverified');
  await client.call('browser_click',{session_id,ref:buttons[0].ref,timeout_ms:4000});
  await client.call('browser_wait_for',{session_id,selector:'[role="dialog"]',timeout_ms:4000});await network();
  stage='address_input';
  const dialog=structured(await client.call('browser_get_content',{session_id,selector:'[role="dialog"]',format:'html',max_bytes:60000}));
  const html=content(dialog);
  if(!html.includes('placeholder="Wpisz nazwę ulicy i numer budynku"'))throw new Error('address_input_unverified');
  const fresh=structured(await client.call('browser_snapshot',{session_id,max_elements:1000,interactive_only:true}));
  const inputs=fresh.elements.filter(item=>item.role==='textbox'&&item.name==='Wpisz nazwę ulicy i numer budynku');
  if(inputs.length>1)throw new Error('address_input_ambiguous');
  // The whole-page snapshot is capped at 1,000 nodes. The scoped, freshly read
  // dialog HTML above proves this input exists; the native selector additionally
  // requires a unique visible control when the snapshot omits that later node.
  const target=inputs.length===1?{ref:inputs[0].ref}:{selector:'[role="dialog"] input[placeholder="Wpisz nazwę ulicy i numer budynku"]:visible'};
  await client.call('browser_type',{session_id,...target,text:config.deliveryQuery,clear_first:true,press_enter_after:false,timeout_ms:4000});
  stage='address_lookup';
  let text='';
  for(let scan=0;scan<8;scan++){
    text=content(structured(await client.call('browser_get_content',{session_id,selector:'[role="dialog"]',format:'text',max_bytes:60000})));
    if(text.includes(config.expectedStreet)&&text.includes(config.expectedCity))break;
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  await network();
  await writeFile(`${ROOT}/private-address-dialog.txt`,text,{mode:0o600});
  const currentHtml=content(structured(await client.call('browser_get_content',{session_id,selector:'[role="dialog"]',format:'html',max_bytes:120000})));
  await writeFile(`${ROOT}/private-address-dialog.html`,currentHtml,{mode:0o600});
  const normalize=value=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/ł/g,'l').toLowerCase();
  const matches=value=>normalize(value).includes(normalize(config.expectedStreet))&&normalize(value).includes(normalize(config.expectedCity))&&new RegExp(`\\b${config.expectedBuilding}\\b`).test(value);
  const candidates=[...currentHtml.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(match=>({tag:'button',label:match[1].replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()})).filter(item=>matches(item.label));
  console.log(JSON.stringify({stage:'candidate_identity',matchingCandidates:candidates.map(item=>({tag:item.tag,streetBuildingCityMatched:true,labelLength:item.label.length}))}));
  if(process.argv.includes('--select-address')){
    const exact=candidates.filter(item=>normalize(item.label).replace(/[\s,]+/g,' ').trim()===normalize(config.deliveryQuery).replace(/[\s,]+/g,' ').trim());
    if(exact.length!==1||exact[0].label.length>160)throw new Error('address_candidate_ambiguous');
    stage='address_selection';
    const excluded=candidates.filter(item=>item!==exact[0]).map(item=>`:not(:has-text(${JSON.stringify(item.label)}))`).join('');
    await client.call('browser_click',{session_id,selector:`[role="dialog"] button:visible:has-text(${JSON.stringify(exact[0].label)})${excluded}`,timeout_ms:5000});
    for(let scan=0;scan<18;scan++){
      text=content(structured(await client.call('browser_get_content',{session_id,selector:'[role="dialog"]',format:'text',max_bytes:60000})));
      if(/nie dostarczamy|poza (?:obszarem|zasięgiem)|Potwierdź adres/.test(text))break;
      await new Promise(resolve=>setTimeout(resolve,350));
    }
    await writeFile(`${ROOT}/private-address-after-selection.txt`,text,{mode:0o600});
    let redacted=text;
    for(const value of [config.deliveryQuery,config.expectedStreet,config.expectedCity,config.expectedPostalCode,config.expectedBuilding])redacted=redacted.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'[private]');
    console.log(JSON.stringify({stage:'post_selection',coverageDenied:/poza (?:obszarem|zasięgiem)|nie dostarczamy|nie obsługujemy/i.test(text),redactedDialogText:redacted.slice(0,1800),fixedMessages:['Zaloguj się','Potwierdź adres','Wybierz adres','Zapisz adres','Dostarczamy','dostarczamy','poza obszarem','Nie dostarczamy','Podaj numer budynku','Numer budynku'].filter(message=>text.includes(message))}));
    if(process.argv.includes('--confirm-address')){
      if(!matches(text)||!text.includes(config.expectedPostalCode)||!text.includes('Potwierdź adres'))throw new Error('address_confirmation_unverified');
      stage='address_confirmation';
      const confirmationSelector='[role="dialog"] button:visible:is(:has-text("Zapisz adres"),:has-text("Potwierdź adres"))';
      const confirmationHtml=content(structured(await client.call('browser_get_content',{session_id,selector:confirmationSelector,format:'html',max_bytes:12000})));
      const controlTags=[...confirmationHtml.matchAll(/<button\b([^>]*)>/g)];
      console.log(JSON.stringify({stage:'visible_confirmation_control',buttons:controlTags.length,disabled:controlTags.some(match=>/\bdisabled(?:\s|=|$)/.test(match[1])),saveAddressLabel:confirmationHtml.includes('Zapisz adres'),confirmAddressLabel:confirmationHtml.includes('Potwierdź adres')}));
      if(controlTags.length!==1||controlTags.some(match=>/\bdisabled(?:\s|=|$)/.test(match[1])))throw new Error('address_confirmation_unverified');
      await client.call('browser_click',{session_id,selector:confirmationSelector,timeout_ms:5000});
      let after;
      for(let scan=0;scan<8;scan++){
        after=structured(await client.call('browser_snapshot',{session_id,max_elements:1000,interactive_only:true}));
        if(after.elements.slice(0,30).some(item=>String(item.name).includes(config.expectedStreet)))break;
        await new Promise(resolve=>setTimeout(resolve,350));
      }
      const afterContent=content(structured(await client.call('browser_get_content',{session_id,format:'text',max_bytes:60000})));
      await writeFile(`${ROOT}/private-after-confirmation.txt`,afterContent,{mode:0o600});
      let safe=afterContent;
      for(const value of [config.deliveryQuery,config.expectedStreet,config.expectedCity,config.expectedPostalCode,config.expectedBuilding])safe=safe.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi'),'[private]');
      console.log(JSON.stringify({stage:'confirmed_address_observation',headerAddressObserved:after.elements.slice(0,30).some(item=>String(item.name).includes(config.expectedStreet)),signInControlObserved:after.elements.some(item=>item.name==='Zaloguj się'),coverageDenied:/poza (?:obszarem|zasięgiem|strefą)|nie dostarczamy|nie obsługujemy|nie dowozimy/i.test(afterContent),redactedPageStart:safe.slice(0,2000)}));
      text=afterContent;
    }
  }
  result={ok:true,stage,browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,addressCandidateTextObserved:text.includes(config.expectedStreet)&&text.includes(config.expectedCity),postcodeObserved:text.includes(config.expectedPostalCode),coverageDenied:/poza (?:obszarem|zasięgiem)|nie dostarczamy|nie obsługujemy/i.test(text),fixedMessages:['Zaloguj się, aby wybrać zapisany adres','Wyszukaj adres dostawy lub przesuń','Nie znaleziono adresu'].filter(message=>text.includes(message)),hosts:[...hosts.values()],allowedHosts,note:'Host event counts may repeat across diagnostic snapshots. Failed requests alone do not prove an allowlist denial. No signup, account terms, cart mutation, checkout quote or purchase.'};
}catch(error){result={ok:false,code:'delivery_lookup_unresolved',stage,stageFailure:['address_input_unverified','address_input_ambiguous','address_candidate_ambiguous','address_control_unverified','address_confirmation_unverified'].includes(error.message)?error.message:null,failure:error.browserFailure||null,browserRuntimeMs:Math.round(performance.now()-started),modelCalls:0,hosts:[...hosts.values()],allowedHosts};}
finally{if(client){try{await client.call('session_destroy',{session_id},{timeoutMs:3000});}catch{}await client.close();}stopDisplay?.();await release();}
await writeFile(`${ROOT}/sanitized-diagnostic.json`,JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
