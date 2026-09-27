import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, 'catalog.json'), 'utf8'));
const knownIds = new Set(catalog.items.map(item => item.productId));
// The operator-facing groceries catalogue is also a bounded allowlist: only
// observed Kraków product IDs may be pushed to the merchant cart.
try {
  const krakow = JSON.parse(readFileSync(join(here, 'catalogue/krakow.json'), 'utf8'));
  for (const item of krakow.items || []) if (/^A\d{7}$/.test(item.productId || '')) knownIds.add(item.productId);
} catch (e) { if (e.code !== 'ENOENT') throw e; }
const safeCode = value => typeof value === 'string' && /^[a-z_]{1,80}$/.test(value) ? value : 'merchant_access_unavailable';

// This fixed transport has no caller-controlled host, command, URL or script.
// Its input is a finite merchant operation, validated again by the worker.
export function remoteWorker(payload, { signal } = {}) {
  return new Promise((resolve, reject) => {
    // A trusted operator may reuse an already authenticated, short-lived SSH
    // connection. This setting is never accepted in an HTTP request or payload.
    const controlPath = process.env.DELIO_SSH_CONTROL_PATH;
    const transportOptions = controlPath ? ['-S', controlPath] : [];
    const child = spawn('ssh', [...transportOptions, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      'root@100.121.5.10', 'docker', 'exec', '-i', 'buena-delio-worker',
      'node', '/app/delio/client.mjs'], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = '', done = false;
    const fail = () => { if (!done) { done = true; reject(Object.assign(new Error('worker_transport_unavailable'), { code:'worker_transport_unavailable' })); } };
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 1_000_000) { child.kill(); fail(); } });
    child.stderr.resume(); child.on('error', fail); child.stdin.on('error', fail);
    child.on('exit', code => {
      if (done) return; done = true;
      try { if (code !== 0) throw new Error(); resolve(JSON.parse(output)); }
      catch { reject(Object.assign(new Error('worker_transport_unavailable'), {code:'worker_transport_unavailable'})); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createDelioAdapter({ storeDir, accountId = 'delio-pilot-owner', invoke = remoteWorker,
  initialAccess = {status:'not_connected',blockers:[{code:'merchant_session_required',message:'An authenticated Delio session and delivery coverage have not yet been verified.'}]} } = {}) {
  let access = structuredClone(initialAccess);
  const path = storeDir && join(storeDir, 'access.json');
  if (path) { mkdirSync(storeDir,{recursive:true,mode:0o700}); try { access = JSON.parse(readFileSync(path,'utf8')); } catch (e) { if(e.code!=='ENOENT') throw e; } }
  function save(value) { access = value; if(path) writeFileSync(path,JSON.stringify(access,null,2),{mode:0o600}); }
  // The worker flags definite no-dispatch stops with dispatched:false; its
  // blocked() replies carry no flag but report a pre-change stop. Only
  // *_uncertain codes leave dispatch genuinely unknown — every other failure
  // is a definite stop whose real code must reach the caller.
  const dispatchState = r => r.dispatched === false ? false : /uncertain/.test(String(r.code || ''));
  async function operation(name, context) {
    if (context.accountId !== accountId) throw Object.assign(new Error('account_not_owned'),{code:'account_not_owned',dispatched:false});
    if (context.lines?.some(line => !knownIds.has(line.productId))) throw Object.assign(new Error('unknown_product_id'),{code:'unknown_product_id',dispatched:false});
    const response = await invoke({operation:name,...(context.lines?{lines:context.lines}:{}) ,...(context.selection?{selection:context.selection}:{})},context);
    if (response.access) save(response.access);
    if (response.ok !== true) {
      save({status:'blocked',observedAt:response.result?.observedAt||Date.now(),blockers:(response.blockers || [{code:safeCode(response.code),message:'Merchant access is not yet verified.'}]).map(b=>({code:safeCode(b.code),message:String(b.message || '').slice(0,600)})),capabilities:response.capabilities || response.result?.capabilities || {},
        evidenceRefs:response.result?.evidenceRefs||[],browserRuntimeMs:response.result?.browserRuntimeMs??null,manualOnboarding:response.result?.manualOnboarding||null});
      throw Object.assign(new Error(safeCode(response.code)),{code:safeCode(response.code),dispatched:dispatchState(response),
        ...(response.result?.blocked?{blocked:response.result.blocked}:{}),
        ...(response.result?.usage?{usage:response.result.usage}:{})});
    }
    return response.result;
  }
  return {catalog:async()=>structuredClone(catalog),getAccess:()=>structuredClone(access),
    observeCart:context=>operation('observeCart',context),mutateCart:context=>operation('mutateCart',context),quote:context=>operation('quote',context),
    applyCoupon:context=>invoke({operation:'applyCoupon',selection:'jev'},context).then(response=>{
      if(response.ok!==true)throw Object.assign(new Error(safeCode(response.code)),{code:safeCode(response.code),dispatched:dispatchState(response),...(response.result?.blocked?{blocked:response.result.blocked}:{}),...(response.result?.usage?{usage:response.result.usage}:{})});
      return response.result;})};
}
