import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openProvider } from './transport.mjs';
import { serveFixtures, attachStressOracle } from './fixtures.mjs';
import { LOCAL_CASES, stressCases } from './suite.mjs';
import { scriptedFormDecider } from './driver.mjs';
import { runLoop } from '../experimental/browser-runtime-v6/runtime.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const root=process.env.BROWSER_STRESS_ROOT||'/tmp/jev-bench-stress-tests';
const tasks=[(await stressCases(root)).find(t=>t.name==='iframe-inception-level1'),LOCAL_CASES.find(t=>t.name==='nested-shadow')];
const output=join(here,'results',`demo-${randomUUID()}`);await mkdir(output,{recursive:true,mode:0o700});
const provider=await openProvider(),server=await serveFixtures(root),results=[];
try{
  for(const task of tasks){
    const browser=await provider.open({origin:server.origin,additionalOrigins:server.additionalOrigins});
    const local=task.layer==='local'?server.start(task):null;
    const oracle=local?{verify:async()=>server.verify(local.id),dispose(){}}:attachStressOracle(browser.page,task);
    const controller=new AbortController();
    try{
      await browser.page.goto(local?.url||`${server.origin}${task.path}`,{waitUntil:'load'});
      const origins=new Set([server.origin,...server.additionalOrigins]);
      const result=await runLoop({page:browser.page,decide:scriptedFormDecider(),signal:controller.signal,maxMs:15000,maxSteps:25,
        allowedFrameUrl:url=>{try{return origins.has(new URL(url).origin);}catch{return false;}},
        spec:{goal:task.goal,values:task.values,policy:{allowDestructive:true,deny:['delete','publish','transfer','buy now','pay now'],denyPath:'',avoid:['delete|publish|transfer|buy now|pay now']}},
        requestFilter:request=>{try{if(origins.has(new URL(request.url()).origin))return 'allow';}catch{}return undefined;},
        onEvent:async event=>{if(event.type==='step_completed'&&(await oracle.verify()).passed)controller.abort('oracle_verified');}});
      const verification=await oracle.verify();
      const screenshot=`${task.name}.png`;await browser.page.screenshot({path:join(output,screenshot),fullPage:true});
      results.push({taskId:task.id,verification,runtimeStatus:result.status,actions:result.metrics.nativeActionAttempts,screenshot});
      console.log(JSON.stringify(results.at(-1)));
    }finally{oracle.dispose();await browser.close();}
  }
}finally{await provider.close();await server.close();}
await writeFile(join(output,'demo.json'),JSON.stringify({scope:'Scripted host-driven demonstrations, same v6 kernel; no Jev accuracy claim. Screenshots are evidence after execution, not model inputs.',results},null,2)+'\n',{mode:0o600});
console.log(`RESULT ${output}`);if(results.some(r=>!r.verification.passed))process.exitCode=1;
