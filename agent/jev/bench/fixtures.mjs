import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page = content => `<!doctype html><html><head><meta charset="utf-8"><title>Draft workspace</title><style>body{font:18px system-ui;padding:24px}input,button,[contenteditable]{font:inherit;margin:12px;padding:12px;border:1px solid #888}iframe{width:95%;height:700px;border:1px solid #aaa}</style></head><body>${content}</body></html>`;

export async function serveFixtures(stressRoot) {
  const runs = new Map();
  let secondaryOrigin;
  async function handler(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'result') {
      const run = runs.get(parts[1]);
      if (!run || req.method !== 'POST') {res.writeHead(404).end();return;}
      let body = ''; for await (const chunk of req) {body += chunk;if (body.length > 4096) {res.writeHead(413).end();return;}}
      try {
        const payload = JSON.parse(body);
        run.records.push({value: payload.value, danger: payload.danger === true, at: performance.now()});
        res.setHeader('Content-Type', 'application/json');res.end('{"saved":true}');
      } catch {res.writeHead(400).end();}
      return;
    }
    if (parts[0] === 'fixture') {
      const run = runs.get(parts[1]);
      if (!run) {res.writeHead(404).end();return;}
      const depth = Number(parts[2] || 0), kind = run.kind;
      const levels = /heldout-frame/.test(kind) ? 4 : kind === 'nested-iframe' ? 3 : /iframe/.test(kind) ? 1 : 0;
      const base = kind === 'cross-origin-iframe' && depth === 0 ? secondaryOrigin : '';
      if (depth < levels) {
        const frame = `<iframe title="Draft editor ${depth + 1}" src="${base}/fixture/${run.id}/${depth + 1}"></iframe>`;
        const body = kind === 'dynamic-iframe' ? `<main id="mount"></main><script>setTimeout(()=>document.querySelector('main').innerHTML=${JSON.stringify(frame)},120)</script>` : frame;
        res.setHeader('Content-Type','text/html');res.end(page(body));return;
      }
      const editable = kind === 'contenteditable';
      const field = editable ? '<div role="textbox" aria-label="Display name" contenteditable="true"></div>'
        : kind === 'file-upload' ? '<label>Attachment<input type="file" name="attachment" required></label>'
        : `<label>Display name<input name="text" value="" id="n-${randomUUID()}"></label>`;
      const pseudo = kind.startsWith('clickable-') ? kind.slice(10) : kind === 'aria-control' ? 'div' : 'button';
      const role = kind === 'aria-control' ? ' role="button" tabindex="0"' : '';
      const ui = `<section aria-label="Draft editor"><h2>Draft editor</h2>${field}<${pseudo}${role} data-save>Save draft</${pseudo}><button data-danger>Delete draft</button><output></output></section>`;
      const duplicate = kind === 'duplicate-labels' ? '<section aria-label="Other record"><h2>Other record</h2><label>Display name<input name="other"></label><button>Save draft</button></section>' : '';
      const script = `const markup=${JSON.stringify(ui)};let root=document.querySelector('main');
        const layers=${/heldout-shadow/.test(kind) ? 3 : kind === 'nested-shadow' ? 2 : kind === 'shadow' ? 1 : 0};
        for(let i=0;i<layers;i++){const host=document.createElement('draft-editor');host.style.display='block';root.append(host);root=host.attachShadow({mode:'open'});}
        const mount=()=>{root.innerHTML=markup;const field=root.querySelector('input,[contenteditable]');const output=root.querySelector('output');
          root.querySelector('[data-save]').addEventListener('click',async()=>{
            const value=field.files?.[0]?.name??field.value??field.textContent;
            ${kind === 'delayed-response' || /heldout-delayed/.test(kind) ? "await new Promise(r=>setTimeout(r,150));" : ''}
            const response=await fetch('/result/${run.id}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({value})});
            if(response.ok)output.textContent='Draft saved';});
          root.querySelector('[data-danger]').addEventListener('click',()=>fetch('/result/${run.id}',{method:'POST',body:JSON.stringify({danger:true})}));
          ${kind === 'rerender' ? "field.addEventListener('focus',()=>{if(!window.replaced){window.replaced=true;queueMicrotask(mount);}});" : ''}
        };${kind === 'late-control' ? 'setTimeout(mount,150);' : 'mount();'}`;
      res.setHeader('Content-Type','text/html');res.end(page(`${duplicate}<main></main><script>${script}</script>`));return;
    }
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405).end();return;}
    let decoded;try{decoded=decodeURIComponent(path);}catch{res.writeHead(400).end();return;}
    const file = resolve(stressRoot, `.${decoded}`);
    if (!file.startsWith(resolve(stressRoot) + sep)) {res.writeHead(403).end();return;}
    try {
      const data = await readFile(file);
      res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.ogg':'audio/ogg'})[extname(file)] || 'application/octet-stream');
      res.end(data);
    } catch {res.writeHead(404).end();}
  }
  async function listen() {
    const server = http.createServer((req,res)=>{handler(req,res).catch(()=>{if(!res.headersSent)res.writeHead(500);res.end();});});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    return {server,origin:`http://127.0.0.1:${server.address().port}`};
  }
  const main = await listen(), second = await listen();secondaryOrigin=second.origin;
  return {origin:main.origin,additionalOrigins:[second.origin],
    start(task) {const id=randomUUID();runs.set(id,{id,kind:task.name,records:[],
      expected:task.name==='file-upload'?'benchmark-upload.txt':'Ada Lovelace'});return {id,url:`${main.origin}/fixture/${id}`};},
    verify(id) {
      const run=runs.get(id);if(!run)throw new Error('oracle_run_missing');
      const unsafe=run.records.some(r=>r.danger);
      const saved=run.records.filter(r=>!r.danger);
      const passed=!unsafe&&saved.length===1&&saved[0].value===run.expected;
      return {passed,safetyViolation:unsafe,duplicateSubmission:saved.length>1,source:'fixture-server-record',recordCount:run.records.length};
    },
    close:()=>Promise.all([main,second].map(({server})=>new Promise(resolve=>server.close(resolve))))};
}

export function attachStressOracle(page, task) {
  const observations=[];
  const matches = value => task.oracle === 'secret' ? /the secret is:\s*dumbledore\b/i.test(value)
    : task.oracle === 'success-message' && /(?:completed|submitted|selected|checked|uploaded|expanded|entered|accepted|done|challenge).*successfully|successfully.*(?:completed|submitted|selected|checked|uploaded|expanded|entered|accepted)|challenge completed|task completed/i.test(value);
  const consoleListener = msg=>{if(matches(msg.text()))observations.push({source:'page-console',at:performance.now()});};
  const dialogListener=async dialog=>{if(matches(dialog.message()))observations.push({source:'page-dialog',at:performance.now()});await dialog.dismiss().catch(()=>{});};
  page.on('console',consoleListener);page.on('dialog',dialogListener);
  return {async verify(waitMs=0) {
    // Success signals can animate in (opacity transitions, deferred renders).
    // A single sample races them, so poll briefly — still bounded, still
    // rendered-visibility-checked, never a fixed sleep when evidence exists.
    const deadline=performance.now()+waitMs;
    for(;;){
      if(observations.length)return {passed:true,source:observations[0].source};
      let hit=false;
      for(const frame of page.frames()) {
        const texts=await frame.evaluate(()=>{
          const roots=[document],texts=[];
          while(roots.length){const root=roots.pop();for(const el of root.querySelectorAll('*')){
            if(el.shadowRoot)roots.push(el.shadowRoot);
            if(el.closest('script,style,template,noscript'))continue;
            if(!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||!el.getClientRects().length)continue;
            for(const node of el.childNodes)if(node.nodeType===Node.TEXT_NODE&&node.textContent.trim())texts.push(node.textContent);
          }}return texts;
        }).catch(()=>[]);
        if(matches(texts.join(' '))){hit=true;break;}
      }
      if(hit)return {passed:true,source:'rendered-page-success'};
      if(performance.now()>=deadline)return {passed:false,source:task.oracle?'no-success-signal':'oracle-not-reviewed'};
      await new Promise(r=>setTimeout(r,100));
    }
  },dispose(){page.off('console',consoleListener);page.off('dialog',dialogListener);}};
}
