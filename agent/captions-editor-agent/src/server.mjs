import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { assert, Stop, VERSION, validateJob } from './policy.mjs';
import { loadJobs, transition } from './storage.mjs';
const hash = x => createHash('sha256').update(x).digest();
const terminal = ['complete', 'needs_attention', 'cancelled'];
export async function createService({ config, dataDir, token, runner, ready }) {
  assert(typeof token === 'string' && token.length >= 32, 'service_token_must_have_32_characters');
  const { jobs, save } = await loadJobs(dataDir); const queue = []; let active = null, draining = null, closing = false;
  const view = job => { const { keyHash, requestHash, ...safe } = job; return safe; };
  const status = async () => ({ mode: config.accountScope === 'owner-authorized' ? 'captions_authorized_account' : 'captions_test_only', policyVersion: VERSION, profileId: config.profileId,
    accountReady: await ready(), testAccountReady: config.testAccountOnly === true && await ready(), activeJobId: active?.job.id || null, queued: queue.filter(x => x.status === 'queued').length,
    allowedAssetIds: Object.keys(config.assets), allowedStyles: config.styles, purchasesEnabled: false, publishingEnabled: false });
  async function drain() {
    while (queue.length && !closing) {
      const job = queue.shift(); if (job.status !== 'queued') continue;
      const controller = new AbortController(); active = { job, controller }; transition(job, 'running'); job.startedAt = new Date().toISOString(); await save(job);
      let result;
      try { if (controller.signal.aborted) result = { status: 'cancelled', reason: 'cancelled_before_browser_start' }; else result = await runner({ id: job.id, task: job.request, signal: controller.signal, progress: async update => { Object.assign(job, update); await save(job); } }); }
      catch { result = { status: 'needs_attention', reason: 'worker_failure_no_replay' }; }
      assert(terminal.includes(result.status), 'invalid_runner_result'); transition(job, result.status); Object.assign(job, result, { finishedAt: new Date().toISOString() });
      await save(job); active = null;
    }
  }
  function schedule() { if (!draining) draining = drain().catch(() => { closing = true; active?.controller.abort(); }).finally(() => { draining = null; if (queue.some(j => j.status === 'queued') && !closing) schedule(); }); }
  async function submit(body, key) {
    assert(!closing, 'service_stopping'); const request = validateJob(body, config);
    assert(typeof key === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(key), 'idempotency_key_required');
    const keyHash = hash(key).toString('hex'), requestHash = hash(JSON.stringify(request)).toString('hex');
    const existing = [...jobs.values()].find(x => x.keyHash === keyHash);
    if (existing) { assert(existing.requestHash === requestHash, 'idempotency_conflict'); return { code: 200, job: view(existing) }; }
    assert(await ready(), 'test_account_onboarding_required');
    // The async readiness check may yield. Recheck the key before synchronous admission.
    const raced = [...jobs.values()].find(x => x.keyHash === keyHash);
    if (raced) { assert(raced.requestHash === requestHash, 'idempotency_conflict'); return { code: 200, job: view(raced) }; }
    assert([...jobs.values()].filter(x => ['queued','running'].includes(x.status)).length < 3, 'queue_full');
    const job = { id: randomUUID(), keyHash, requestHash, request, status: 'queued', createdAt: new Date().toISOString(), purchases: 0 };
    jobs.set(job.id, job);
    try { await save(job); } catch (e) { jobs.delete(job.id); throw e; }
    queue.push(job); schedule(); return { code: 202, job: view(job) };
  }
  async function cancel(id) {
    const job = jobs.get(id); assert(job, 'job_not_found');
    if (job.status === 'queued') { transition(job, 'cancelled'); job.finishedAt = new Date().toISOString(); await save(job); }
    if (active?.job.id === id) active.controller.abort(); return view(job);
  }
  async function artifacts(id) {
    assert(jobs.has(id), 'job_not_found'); const dir = join(dataDir, 'artifacts', id); let files;
    try { files = await readdir(dir); } catch { return []; }
    return (await Promise.all(files.filter(x => /^[a-zA-Z0-9_.-]+\.(?:json|jsonl|png|mp4)$/.test(x)).map(async name => {
      const size = (await stat(join(dir, name))).size;
      return { name, bytes: size, url: `/v1/jobs/${id}/artifacts/${name}` };
    })));
  }
  const tools = [
    { name: 'editor_status', description: 'Read the isolated test editor state; never exposes cookies or credentials.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
    { name: 'editor_submit', description: 'Submit one bounded authorized asset to Captions: upload, numeric trim, captions, copy, export, verify. No purchase or publishing actions.', inputSchema: { type: 'object', additionalProperties: false, required: ['idempotencyKey','task'], properties: { idempotencyKey: { type:'string' }, task: { type:'object', additionalProperties:false, required:['assetId','trimStart','trimEnd','style','expectedCaption'], properties: { assetId:{type:'string'}, trimStart:{type:'number'},trimEnd:{type:'number'},style:{type:'string'},expectedCaption:{type:'string'},requireSubtitleTrack:{type:'boolean'} } } } } },
    ...['editor_job','editor_cancel','editor_artifacts'].map(name => ({ name, description: name.replaceAll('_',' '), inputSchema: { type:'object', additionalProperties:false, required:['jobId'],properties:{jobId:{type:'string'}} } })),
  ];
  async function mcp(request) {
    const response = result => ({ jsonrpc:'2.0', id:request.id, result });
    if (request.method === 'initialize') return response({ protocolVersion:'2024-11-05', capabilities:{tools:{}},serverInfo:{name:'buena-captions-editor-agent',version:'0.1.0'} });
    if (request.method === 'notifications/initialized') return null;
    if (request.method === 'ping') return response({});
    if (request.method === 'tools/list') return response({tools});
    if (request.method === 'tools/call') {
      const { name, arguments:a={} } = request.params || {}; let value;
      if (name === 'editor_status') value = await status();
      else if (name === 'editor_submit') value = (await submit(a.task,a.idempotencyKey)).job;
      else if (name === 'editor_cancel') value = await cancel(a.jobId);
      else if (name === 'editor_artifacts') value = await artifacts(a.jobId);
      else if (name === 'editor_job') { assert(jobs.has(a.jobId), 'job_not_found'); value = view(jobs.get(a.jobId)); }
      else throw new Stop('unknown_tool');
      return response({content:[{type:'text',text:JSON.stringify(value)}]});
    }
    return {jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}};
  }
  const send = (res, code, data) => { res.writeHead(code, {'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); res.end(JSON.stringify(data)); };
  async function body(req) { let result = ''; for await (const chunk of req) { result += chunk; assert(Buffer.byteLength(result) <= 8192,'request_too_large'); } try { return JSON.parse(result); } catch { throw new Stop('invalid_json'); } }
  const server = createServer(async (req,res) => {
    try {
      const path = new URL(req.url,'http://localhost').pathname;
      if (req.method==='GET' && path==='/healthz') return send(res,closing?503:200,{ok:!closing,mode:config.accountScope === 'owner-authorized' ? 'captions_authorized_account' : 'captions_test_only'});
      if (!timingSafeEqual(hash(req.headers.authorization||''),hash(`Bearer ${token}`))) return send(res,401,{error:'unauthorized'});
      if (req.headers.origin) return send(res,403,{error:'browser_origin_not_supported'});
      if (req.method==='GET' && path==='/v1/status') return send(res,200,await status());
      if (req.method==='GET' && path==='/v1/jobs') return send(res,200,[...jobs.values()].slice(-50).map(view));
      if (req.method==='POST' && path==='/v1/jobs') { const r=await submit(await body(req),req.headers['idempotency-key']); return send(res,r.code,r.job); }
      if (req.method==='POST' && path==='/mcp') { const r=await mcp(await body(req)); if(r===null){res.writeHead(202);return res.end();}return send(res,200,r); }
      const match=path.match(/^\/v1\/jobs\/([a-f0-9-]{36})(?:\/(cancel|artifacts)(?:\/([a-zA-Z0-9_.-]+))?)?$/);
      if(match){const [,id,action,name]=match;assert(jobs.has(id),'job_not_found');
        if(req.method==='GET'&&!action)return send(res,200,view(jobs.get(id)));
        if(req.method==='POST'&&action==='cancel'&&!name)return send(res,202,await cancel(id));
        if(req.method==='GET'&&action==='artifacts'){
          const list=await artifacts(id);if(!name)return send(res,200,list);assert(list.some(x=>x.name===name),'artifact_not_found');
          const base=await realpath(join(dataDir,'artifacts',id)), file=await realpath(join(base,name));assert(file.startsWith(base+sep),'artifact_outside_job');
          const size=(await stat(file)).size;res.writeHead(200,{'Content-Type':name.endsWith('.mp4')?'video/mp4':name.endsWith('.png')?'image/png':'application/json','Content-Length':size,'Cache-Control':'no-store','Content-Disposition':`attachment; filename="${name}"`});
          return createReadStream(file).pipe(res);
        }
      }
      return send(res,404,{error:'not_found'});
    } catch(e){const code=e instanceof Stop?e.code:'internal_error';return send(res,code==='queue_full'?429:code==='idempotency_conflict'?409:code.endsWith('not_found')?404:code==='test_account_onboarding_required'?409:e instanceof Stop?400:500,{error:code});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,jobs,submit,cancel,async close(){closing=true;active?.controller.abort();await new Promise(r=>server.close(r));if(draining)await draining;for(const job of queue)if(job.status==='queued'){transition(job,'needs_attention');job.reason='server_stopped_no_replay';await save(job);}}};
}
