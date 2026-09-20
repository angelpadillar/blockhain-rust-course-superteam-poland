import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { settings } from './config.mjs';
import { openBrowser } from './browser.mjs';
import { startDisplay } from './display.mjs';
import { journal } from './storage.mjs';
const {config,dataDir}=await settings();await mkdir(dataDir,{recursive:true,mode:0o700});
const stopDisplay=await startDisplay({desktop:true});let session;
try{session=await openBrowser(config,dataDir,{desktop:true,onBlocked:detail=>void journal(join(dataDir,'onboarding'),{type:'network_blocked',...detail})});
  await session.page.goto(config.editorUrl,{waitUntil:'domcontentloaded'});
  // Captions' public home exposes its login form through the observed /signup
  // link. Opening that form does not create an account or start a trial.
  const login=session.page.getByRole('link',{name:'Sign up',exact:true});
  if(await login.waitFor({state:'visible',timeout:12000}).then(()=>true).catch(()=>false)){
    if(await login.getAttribute('href')==='/signup')await login.click().catch(()=>{});
  }
  console.log('Private password-protected account desktop ready. Finish login, stop this container, then confirm the authorized-account marker before starting worker.');
}catch(e){await session?.close().catch(()=>{});stopDisplay();console.error(e.code||'onboarding_failed');process.exit(1);}
let stopping=false;for(const event of ['SIGTERM','SIGINT'])process.on(event,async()=>{if(stopping)return;stopping=true;await session.close();stopDisplay();process.exit(0);});
