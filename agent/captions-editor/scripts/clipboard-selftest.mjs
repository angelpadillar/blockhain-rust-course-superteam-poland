import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { McpClient, structured, pngBytes } from '../src/mcp.mjs';
import { fixtureArgs } from '../src/config.mjs';
import { startDisplay } from '../src/display.mjs';

// Run only in a fresh network-none container. Both the X11 clipboard and the
// browser profiles belong solely to this fixture; no live desktop is connected.
const run = promisify(execFile), root = process.env.FIXTURE_ROOT || '/app/state';
await mkdir(root, { recursive: true });
const dir = await mkdtemp(path.join(root, 'clipboard-'));
const started = Date.now(), checks = {}, canaryOut = 'https://example.invalid/to-vps-72ab', canaryIn = 'https://example.invalid/share/c6f727a09219';
let server, stopDisplay, client, localDisplay; const transportChildren = []; const clients = new Map();
const check = (name, truth) => { checks[name] = Boolean(truth); if (!truth) throw Error('Failed: ' + name); };
const report = { purpose: 'Isolated noVNC clipboard canaries only', checks, artifacts: dir };
try {
  process.env.VNC_PASSWORD_FILE = path.join(dir, 'fixture-vnc-password');
  await run('x11vnc', ['-storepasswd', 'fixture1', process.env.VNC_PASSWORD_FILE]);
  stopDisplay = await startDisplay();
  transportChildren.push(spawn('x11vnc',['-display',':99','-localhost','-forever','-shared','-noprimary','-rfbauth',process.env.VNC_PASSWORD_FILE,'-rfbport','5900','-o',path.join(dir,'vnc.log')],{stdio:'ignore'}));
  transportChildren.push(spawn('websockify',['--web=/usr/share/novnc','6080','127.0.0.1:5900'],{stdio:'ignore'}));
  server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Clipboard fixture</title><label>Remote paste target<input id="target" aria-label="Remote paste target"></label><textarea id="source" aria-label="Share URL">${canaryIn}</textarea><button id="copy">Copy synthetic remote text</button><p id="status">Ready</p><script>document.getElementById('copy').onclick=()=>{document.getElementById('source').select();document.getElementById('status').textContent=document.execCommand('copy')?'Synthetic copy succeeded':'Synthetic copy failed'}</script>`); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  localDisplay = spawn('Xvfb', [':100', '-screen', '0', '1200x1000x24', '-nolisten', 'tcp'], {stdio:'ignore'});
  for (let i=0;i<30;i++) { try { await access('/tmp/.X11-unix/X100'); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  for (const session of ['local-ui', 'remote-fixture']) {
    const sessionDir = path.join(dir,session); await mkdir(sessionDir);
    const args = fixtureArgs(sessionDir); args.push('--allow-snapshot-values');
    const child = new McpClient(args, {spawnImpl: (binary, args, options) => spawn(binary,args,{...options,env:{...options.env,DISPLAY:session==='local-ui'?':100':':99'}})});
    clients.set(session, child); await child.initialize();
    await child.call('session_create', { session_id: session, headful: true, width: 1000, height: 900, profile_path: session });
  }
  client = { call: (name,args) => clients.get(args.session_id).call(name,args) };
  await client.call('browser_navigate', { session_id: 'remote-fixture', url: `http://127.0.0.1:${server.address().port}/`, wait_until: 'domcontentloaded' });
  await client.call('browser_navigate', { session_id: 'local-ui', url: 'http://127.0.0.1:6080/vnc.html?autoconnect=1&password=fixture1&resize=scale', wait_until: 'domcontentloaded' });
  const snapshot = async session => structured(await client.call('browser_snapshot', { session_id: session, interactive_only: true, include_values: true, max_elements: 200 }));
  const find = async (session, name) => {
    const found = (await snapshot(session)).elements.filter(e => e.name === name);
    if (found.length !== 1) throw Error('Fixture control missing/ambiguous: ' + name);
    return found[0];
  };
  const click = async (session, name) => client.call('browser_click', { session_id: session, ref: (await find(session, name)).ref });
  await client.call('browser_wait_for', { session_id: 'local-ui', text: 'Copy / Paste', timeout_ms: 15000 });
  await click('local-ui', 'Copy / Paste');
  let connected = false;
  for (let i = 0; i < 30; i++) { if (!(await find('local-ui', 'Send to VPS')).disabled) { connected = true; break; } await new Promise(r => setTimeout(r, 100)); }
  check('authenticatedRfbConnection', connected);
  // x11vnc initially delays selection monitoring (upstream sel_waittime=15).
  await new Promise(r => setTimeout(r, 16000));
  await client.call('browser_type', { session_id: 'local-ui', ref: (await find('local-ui', 'Your device → VPS')).ref, text: canaryOut, clear_first: true });
  report.syntheticOutgoing = await find('local-ui', 'Your device → VPS');
  await click('local-ui', 'Send to VPS');
  await new Promise(r => setTimeout(r, 2200));
  await client.call('browser_press_key', { session_id: 'remote-fixture', ref: (await find('remote-fixture', 'Remote paste target')).ref, key: 'Control+v' });
  const clipboard = async (display, selection='CLIPBOARD') => (await run('python3', ['/app/scripts/fixture-clipboard.py'], {env:{...process.env,DISPLAY:display,BUENA_CLIPBOARD_FIXTURE:'1',BUENA_FIXTURE_SELECTION:selection}})).stdout;
  check('deviceToRemoteExactCanary', await clipboard(':99') === canaryOut);
  await click('remote-fixture', 'Copy synthetic remote text');
  await client.call('browser_wait_for',{session_id:'local-ui',text:'Text received from VPS. Choose Copy to device.',timeout_ms:10000});
  check('remoteCopyExactCanary', await clipboard(':99') === canaryIn);
  await writeFile(path.join(dir,'panel.png'),pngBytes(await client.call('browser_screenshot',{session_id:'local-ui',full_page:false})));
  await client.call('browser_press_key', {session_id:'remote-fixture',ref:(await find('remote-fixture','Share URL')).ref,key:'End'});
  await client.call('browser_press_key', {session_id:'remote-fixture',ref:(await find('remote-fixture','Share URL')).ref,key:'Control+Shift+ArrowLeft'});
  await new Promise(r=>setTimeout(r,1000));
  check('fragmentHighlightedWithoutCopy', await clipboard(':99','PRIMARY') === 'c6f727a09219');
  check('explicitClipboardStillFullUrl', await clipboard(':99') === canaryIn);
  const beforeLocalCopy = await clipboard(':100').catch(()=>null);
  check('localClipboardWasDistinct', beforeLocalCopy !== canaryIn);
  await click('local-ui', 'Copy to device');
  check('remoteToIndependentLocalClipboardExactCanary', await clipboard(':100') === canaryIn);
  await writeFile(path.join(dir,'after-fragment.png'),pngBytes(await client.call('browser_screenshot',{session_id:'local-ui',full_page:false})));
  report.status = 'passed';
} catch (error) { if(client) { try { await writeFile(path.join(dir,'failed-ui.png'),pngBytes(await client.call('browser_screenshot',{session_id:'local-ui',full_page:false}))); await writeFile(path.join(dir,'failed-remote.png'),pngBytes(await client.call('browser_screenshot',{session_id:'remote-fixture',full_page:false}))); } catch {} } report.fixtureVncLog = await readFile(path.join(dir,'vnc.log'),'utf8').then(v=>v.slice(-5000)).catch(()=>null); report.status = 'failed'; report.blocker = error.message; if (error.browserFailure) report.browserFailure = error.browserFailure; process.exitCode = 1; }
finally {
  for (const [session, child] of clients) { try { await child.call('session_destroy', { session_id: session }, { timeoutMs: 5000 }); } catch {} await child.close(); }
  server?.closeAllConnections(); server?.close(); stopDisplay?.(); localDisplay?.kill('SIGTERM'); for(const child of transportChildren) child.kill('SIGTERM');
  report.wallTimeSeconds = (Date.now() - started) / 1000;
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
