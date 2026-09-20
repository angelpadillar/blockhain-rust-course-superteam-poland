import { writeFile } from 'node:fs/promises';
import { McpClient, structured, pngBytes } from './vendor/mcp.mjs';
import { startDisplay } from './vendor/display.mjs';
import { acquireOwner } from './vendor/lock.mjs';

// Operator-only initial inspection. No address, login, cookie, or mutation input.
process.umask(0o077);
const root='/app/state';
const started=performance.now();
const release=await acquireOwner(root);
let stopDisplay,client;
try {
  stopDisplay=await startDisplay();
  client=new McpClient(['mcp','--transport','stdio','--toolset','core','--session-dir',root,'--allowed-hosts','delio.com.pl','--max-sessions','1','--session-ttl','10m'],{timeoutMs:25000});
  await client.initialize();
  await client.call('session_create',{session_id:'delio-owner',headful:true,width:1360,height:900,profile_path:'delio-owner',reuse_if_exists:true});
  const navigation=structured(await client.call('browser_navigate',{session_id:'delio-owner',require_existing:true,url:'https://delio.com.pl/',wait_until:'domcontentloaded',timeout_ms:22000}));
  const snapshot=structured(await client.call('browser_snapshot',{session_id:'delio-owner',max_elements:180,interactive_only:false}));
  await writeFile(`${root}/initial-snapshot.json`,JSON.stringify(snapshot,null,2),{mode:0o600});
  const screenshot=pngBytes(await client.call('browser_screenshot',{session_id:'delio-owner',full_page:false,max_bytes:2097152}));
  await writeFile(`${root}/initial-home.png`,screenshot,{mode:0o600});
  console.log(JSON.stringify({ok:true,browserRuntimeMs:Math.round(performance.now()-started),navigation,snapshot}));
} catch(error) {console.log(JSON.stringify({ok:false,code:'initial_probe_failed',failure:error.browserFailure || null,browserRuntimeMs:Math.round(performance.now()-started)}));process.exitCode=1;}
finally {if(client){try{await client.call('session_destroy',{session_id:'delio-owner'},{timeoutMs:5000});}catch{}await client.close();}stopDisplay?.();await release();}
