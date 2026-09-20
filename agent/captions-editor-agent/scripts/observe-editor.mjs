// Read-only calibration after manual desktop releases profile ownership. No editor clicks/uploads.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { settings } from '../src/config.mjs';
import { openBrowser, CaptionsAdapter } from '../src/browser.mjs';
import { startDisplay } from '../src/display.mjs';
import { journal, saveJson } from '../src/storage.mjs';
const {config,dataDir}=await settings(),dir=join(dataDir,'calibration');
await mkdir(dir,{recursive:true,mode:0o700});const stopDisplay=await startDisplay();let session;
try{session=await openBrowser(config,dataDir,{onBlocked:d=>void journal(dir,{type:'network_blocked',...d})});
  await session.page.goto(config.editorUrl,{waitUntil:'domcontentloaded'});
  const adapter=new CaptionsAdapter({session,config,artifactDir:dir,event:d=>journal(dir,d),signal:AbortSignal.timeout(60000)});
  const observation=await adapter.observe('calibration',true);await saveJson(join(dir,'observation.json'),observation);
  console.log(JSON.stringify({url:observation.url,files:observation.files,controls:observation.controls.filter(c=>c.visible),screenshot:observation.screenshot}));
}finally{await session?.close();stopDisplay();}
