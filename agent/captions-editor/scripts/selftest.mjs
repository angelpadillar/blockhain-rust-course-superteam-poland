import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { McpClient, structured, pngBytes } from '../src/mcp.mjs';
import { fixtureArgs, UPSTREAM_VERSION } from '../src/config.mjs';
import { startDisplay } from '../src/display.mjs';
import { AutomationBridge } from '../src/automation.mjs';

// This proves browser capabilities, not Captions editing or caption quality.
// Compose runs it with network_mode:none; only its own loopback fixture exists.
process.umask(0o077);
const run = promisify(execFile);
const root = process.env.FIXTURE_ROOT || '/app/state';
await mkdir(root, { recursive: true, mode: 0o700 });
const stateDir = await mkdtemp(path.join(root, 'fixture-'));
const source = path.join(stateDir, 'source.mp4');
const target = path.join(stateDir, 'exports', 'fixture', 'export.mp4');
const started = Date.now();
const report = { purpose: 'Offline browser capability test; not a Captions export', startedAt: new Date().toISOString(), checks: {}, artifacts: stateDir };
let stopDisplay, client, server;
const check = (name, condition) => { report.checks[name] = Boolean(condition); if (!condition) throw new Error(`Check failed: ${name}`); };
const hash = data => createHash('sha256').update(data).digest('hex');
const controlDelayMs = Number(process.env.FIXTURE_CONTROL_DELAY_MS || 0);
if (!Number.isInteger(controlDelayMs) || controlDelayMs < 0 || controlDelayMs > 5000) throw new Error('Invalid fixture control delay');
const readySelection = process.env.FIXTURE_READY_SELECTION === '1';
report.readinessExperiment = { controlDelayMs, readySelection };
try {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=90x160:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', source]);
  const video = await readFile(source);
  const repeatedSwitches = ["Left switch", "Middle switch", "Right switch"].map(label => `<section>${"<div>".repeat(8)}<span>${label}</span><button role="switch" aria-checked="true" data-fixture-switch="${label}"></button>${"</div>".repeat(8)}</section>`).join("");
  const html = '<!doctype html><html><head><title>Buena offline browser test</title></head><body><h1>Offline test project</h1><label for="asset">Test clip</label><input id="asset" type="file" style="display:none" accept="video/mp4"><p id="status" role="status">No clip selected</p><label for="prompt">Edit prompt</label><textarea id="prompt"></textarea><p id="promptState">No prompt</p><button id="apply">Apply test edit</button><p id="editState">Not edited</p><label for="media">Generate media</label><input id="media" type="checkbox" checked><p id="mediaState">Media enabled</p><div role="checkbox" aria-label="Custom checkbox" aria-checked="false" tabindex="0">Custom checkbox</div><button disabled>Unavailable edit</button><label for="voiceSwitch">Voiceover only</label><button role="switch" id="voiceSwitch" aria-checked="true"></button><p id="voiceState">Voiceover on</p><div><span>Generate extra images</span><button role="switch" id="extraSwitch" aria-checked="true"></button></div><p id="extraState">Extra images on</p>' + repeatedSwitches + '<p id="deepState">Deep switches on</p><a id="export" href="/export.mp4" download="copy.mp4">Export fixture copy</a><script>document.getElementById("asset").addEventListener("change",function(){document.getElementById("status").textContent=this.files[0] ? "Selected "+this.files[0].name : "No clip selected";});document.getElementById("prompt").addEventListener("input",()=>document.getElementById("promptState").textContent="Prompt ready");document.getElementById("apply").addEventListener("click",()=>document.getElementById("editState").textContent="Test edit saved");document.getElementById("media").addEventListener("change",function(){document.getElementById("mediaState").textContent=this.checked ? "Media enabled" : "Media disabled";});document.getElementById("voiceSwitch").addEventListener("click",function(){this.setAttribute("aria-checked","false");document.getElementById("voiceState").textContent="Voiceover off";});document.getElementById("extraSwitch").addEventListener("click",function(){this.setAttribute("aria-checked","false");document.getElementById("extraState").textContent="Extra images off";});document.querySelectorAll("button[data-fixture-switch]").forEach(button=>button.addEventListener("click",function(){this.setAttribute("aria-checked","false");document.getElementById("deepState").textContent="Changed "+this.getAttribute("data-fixture-switch");}));</script></body></html>';
  server = http.createServer((req, res) => {
    if (req.url === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(html.replace('</script>', `if (${controlDelayMs} > 0) { const input = document.getElementById('asset'); input.disabled = true; setTimeout(() => input.disabled = false, ${controlDelayMs}); }</script>`)); }
    else if (req.url === '/export.mp4' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="fixture.mp4"', 'Content-Length': video.length }); res.end(video); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  stopDisplay = await startDisplay();
  client = new McpClient(fixtureArgs(stateDir));
  const init = await client.initialize();
  check('pinnedUpstreamVersion', String(init.serverInfo?.version).replace(/^v/, '') === UPSTREAM_VERSION);
  const required = ['browser_capabilities', 'session_create', 'session_destroy', 'browser_navigate', 'browser_snapshot', 'browser_get_content', 'browser_screenshot', 'browser_upload_file', 'browser_download', 'browser_type', 'browser_click', 'browser_wait_for', 'browser_set_checked'];
  client.requireTools(required);
  await writeFile(path.join(stateDir, 'live-contract.json'), JSON.stringify(client.tools.filter(tool => required.includes(tool.name)), null, 2));
  const caps = structured(await client.call('browser_capabilities'));
  check('fileCapabilities', caps.features?.browser_upload_file?.callable && caps.features?.browser_download?.callable);
  check('sensitiveGatesClosed', ['--enable-eval', '--allow-cookie-values', '--allow-cookie-mutation', '--allow-session-export', '--allow-session-import', '--allow-session-proxy', '--allow-browser-fetch'].every(flag => caps.gates?.[flag] === false));
  await client.call('session_create', { session_id: 'fixture', headful: true, width: 900, height: 800, profile_path: 'offline-fixture' });
  await client.call('browser_navigate', { session_id: 'fixture', require_existing: true, url, wait_until: 'domcontentloaded' });
  const snapshot = structured(await client.call('browser_snapshot', { session_id: 'fixture', interactive_only: false, include_values: false }));
  await writeFile(path.join(stateDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  check('domSnapshot', JSON.stringify(snapshot).includes('Offline test project') && JSON.stringify(snapshot).includes('Export fixture copy'));
  check('hiddenFileInputMetadata', snapshot.elements.some(element => element.role === 'file' && element.name === 'Test clip' && element.input_type === 'file' && element.hidden === true));
  check('nativeCheckboxMetadata', snapshot.elements.some(element => element.role === 'checkbox' && element.name === 'Generate media' && element.checked === true));
  check('customCheckboxMetadata', snapshot.elements.some(element => element.role === 'checkbox' && element.name === 'Custom checkbox' && element.checked === false));
  check('switchMetadata', snapshot.elements.some(element => element.role === 'switch' && element.name === 'Voiceover only' && element.checked === true));
  check('unnamedSwitchContext', snapshot.elements.some(element => element.role === 'switch' && element.name === '' && element.label_context === 'Generate extra images' && element.checked === true));
  check('disabledMetadata', snapshot.elements.some(element => element.name === 'Unavailable edit' && element.disabled === true));
  const png = pngBytes(await client.call('browser_screenshot', { session_id: 'fixture', full_page: false }));
  await writeFile(path.join(stateDir, 'screenshot.png'), png); check('pngScreenshot', png.length > 100);
  const control = (name, context) => { const matches = snapshot.elements.filter(element => element.name === name && (context === undefined || element.label_context === context)); if (matches.length !== 1) throw new Error('Offline fixture target is ambiguous: ' + name); return { role: matches[0].role, name, ...(name === '' ? { labelContext: matches[0].label_context } : {}) }; };
  const policy = { version: 1, assets: [{ id: 'fixture', file: 'source.mp4', sha256: hash(video) }], jobs: [{ id: 'fixture', assetId: 'fixture', startUrl: url, prompt: 'Keep the source video and test the prompt control.', steps: [
    { id: 'upload', operation: 'upload', controls: [control('Test clip')], verifyText: 'Selected source.mp4' },
    { id: 'prompt', operation: 'fill_prompt', controls: [control('Edit prompt')], verifyText: 'Prompt ready' },
    { id: 'disable-media', operation: 'uncheck', controls: [control('Generate media')], verifyText: 'Media disabled' },
    { id: 'voice-off', operation: 'uncheck', controls: [control('Voiceover only')], verifyText: 'Voiceover off' },
    { id: 'extra-off', operation: 'uncheck', controls: [control('', 'Generate extra images')], verifyText: 'Extra images off' },
    { id: 'deep-middle-off', operation: 'uncheck', controls: [control('', 'Middle switch')], verifyText: 'Changed Middle switch' },
    { id: 'edit', operation: 'click', controls: [control('Apply test edit')], verifyText: 'Test edit saved' },
    { id: 'download', operation: 'export', controls: [control('Export fixture copy')] }
  ] }] };
  const bridge = new AutomationBridge({ client, stateDir, assetsDir: stateDir, manifestLoader: async () => policy, sessionId: 'fixture', allowedOrigin: new URL(url).origin }); await bridge.initialize();
  // Start a fresh document after calibration so delayed readiness is measured
  // from navigation, not consumed by the initial metadata/screenshot checks.
  if (controlDelayMs) await client.call('browser_navigate', { session_id: 'fixture', require_existing: true, url, wait_until: 'domcontentloaded' });
  report.stepTimings = [];
  report.readinessSelections = [];
  for (const step of policy.jobs[0].steps) {
    let selection;
    if (readySelection) selection = await bridge.selectReady({ jobId: 'fixture', waitMs: 5000 });
    else { const observation = await bridge.observe(); selection = await bridge.select({ jobId: 'fixture', observationToken: observation.observationToken }); }
    report.readinessSelections.push({ stepId: step.id, method: selection.selectionMethod, observations: selection.observations ?? 1, readinessMs: selection.readinessMs ?? null });
    const receipt = await bridge.act({ jobId: 'fixture', idempotencyKey: step.id, observationToken: selection.observationToken, ref: selection.ref, selectionToken: selection.selectionToken });
    check('bridge_' + step.id, receipt.outcome === 'verified_postcondition'); report.stepTimings.push(receipt);
  }
  const finalSnapshot = await bridge.observe();
  check('switchesRemainOff', finalSnapshot.elements.filter(element => element.role === 'switch' && ['Voiceover only','Generate extra images'].includes(element.name || element.label_context)).every(element => element.checked === false));
  check('onlyIntendedDeepSwitchChanged', ['Left switch', 'Middle switch', 'Right switch'].every(label => { const element = finalSnapshot.elements.find(element => element.label_context === label); return element && element.checked === (label !== 'Middle switch'); }));
  check('checkboxRemainsOff', finalSnapshot.elements.some(element => element.name === 'Generate media' && element.checked === false));
  const content = structured(await client.call('browser_get_content', { session_id: 'fixture', format: 'text', selector: '#status' }));
  check('fileInput', JSON.stringify(content).includes('Selected source.mp4'));
  const downloaded = await readFile(target); check('downloadBytesMatch', hash(video) === hash(downloaded));
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', target]);
  const probe = JSON.parse(stdout); const stream = probe.streams.find(item => item.codec_type === 'video');
  check('verticalDimensions', stream?.width === 90 && stream?.height === 160);
  check('duration', Math.abs(Number(probe.format.duration) - 1) < 0.05);
  await run('ffmpeg', ['-hide_banner', '-v', 'error', '-i', target, '-f', 'null', '-']); check('fullDecode', true);
  report.sha256 = hash(downloaded); report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.blocker = error.message; process.exitCode = 1;
} finally {
  if (client) { try { await client.call('session_destroy', { session_id: 'fixture' }, { timeoutMs: 12000 }); } catch {} await client.close(); }
  server?.closeAllConnections(); await new Promise(resolve => server ? server.close(resolve) : resolve());
  stopDisplay?.(); report.wallTimeSeconds = (Date.now() - started) / 1000;
  await writeFile(path.join(stateDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
