import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, onboardingArgs, SESSION_ID, UPSTREAM_VERSION } from './config.mjs';
import { McpClient, structured } from './mcp.mjs';
import { acquireOwner } from './lock.mjs';
import { startDisplay, maximizeBrowser } from './display.mjs';
import { createObserver, listenObserver } from './observe-server.mjs';
import { AutomationBridge } from './automation.mjs';
import { createJev } from './jev.mjs';

process.umask(0o077);
const config = validateConfig(JSON.parse(await readFile(process.env.CANDIDATE_CONFIG || '/app/config/editor.json', 'utf8')));
const token = (await readFile(process.env.CANDIDATE_TOKEN_FILE || '/run/secrets/service_token', 'utf8')).trim();
const release = await acquireOwner(config.stateDir);
let stopDisplay, client, observer, shuttingDown = false;
let state = { status: 'starting', engine: 'gomoufox', expectedVersion: UPSTREAM_VERSION, upstreamPatch: 'observed-inputs-v3', automatedEditing: false };
const saveStatus = async () => writeFile(path.join(config.stateDir, 'status.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  observer?.close();
  if (client) { try { await client.call('session_destroy', { session_id: SESSION_ID }, { timeoutMs: 12000 }); } catch {} await client.close(); }
  stopDisplay?.(); await release();
}
process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
try {
  stopDisplay = await startDisplay({ desktop: true });
  const automation = process.env.CANDIDATE_AUTOMATION === '1';
  client = new McpClient(onboardingArgs(config, { automation }));
  const init = await client.initialize();
  if (String(init.serverInfo?.version).replace(/^v/, '') !== UPSTREAM_VERSION) throw new Error('Pinned gomoufox version mismatch');
  client.requireTools(['browser_capabilities', 'session_create', 'session_destroy', 'browser_navigate', 'browser_snapshot', 'browser_screenshot']);
  const capabilities = structured(await client.call('browser_capabilities'));
  await writeFile(path.join(config.stateDir, 'capabilities.json'), JSON.stringify(capabilities, null, 2), { mode: 0o600 });
  await client.call('session_create', { session_id: SESSION_ID, reuse_if_exists: true, headful: true, width: 1440, height: 900, profile_path: 'captions-trial' });
  let bridge = null;
  if (automation) {
    let apiKey; if (process.env.TYPESAFE_KEY_FILE) { try { apiKey = (await readFile(process.env.TYPESAFE_KEY_FILE, 'utf8')).trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    bridge = new AutomationBridge({ client, stateDir: config.stateDir, assetsDir: '/app/assets', manifestFile: process.env.CANDIDATE_JOBS_FILE || '/app/config/jobs.json', chooser: createJev({ apiKey }) });
    await bridge.initialize(); await bridge.manifest();
    state = { ...state, automatedEditing: true, typesafeConfigured: Boolean(apiKey) };
  }
  observer = createObserver({ client, token, bridge, getStatus: () => ({ ...state, runtimeAlive: !client.closed }) }); await listenObserver(observer);
  try {
    if (config.resumeJobId && !bridge) throw new Error('Resume requires the guarded job bridge');
    const initialUrl = config.resumeJobId ? await bridge.resumeUrl(config.resumeJobId) : config.initialUrl;
    await client.call('browser_navigate', { session_id: SESSION_ID, require_existing: true, url: initialUrl, wait_until: 'domcontentloaded', timeout_ms: 60000 });
    const maximizedWindows = await maximizeBrowser();
    state = { ...state, status: 'ready_for_observation', version: init.serverInfo.version, maximizedWindows, viewport: { width: 1440, height: 900 }, fluidViewportSupported: false };
  } catch (error) {
    state = { ...state, status: 'needs_attention', blocker: error.message, version: init.serverInfo.version };
  }
  await saveStatus(); console.log(JSON.stringify(state));
  // Browser lifetime stays owned by this process. The optional bridge accepts
  // only manifest-approved job actions; it never logs in or exports cookies.
} catch (error) {
  state = { ...state, status: 'failed', blocker: error.message }; await saveStatus();
  console.error(JSON.stringify(state)); await shutdown(); process.exitCode = 1;
}
