import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpToolset, mcpToolNames, mcpRoles } from '../src/mcp.mjs';
import { createServer, serverInfo, protocolVersion } from '../mcp/server.mjs';
import { BrowserExecutionKernel } from '../src/execution.mjs';
import { createReceiptStore } from '../src/receipts.mjs';
import { createEphemeralVault } from '../src/secrets.mjs';

const site = { origins: ['https://www.youtube.com'], credentialOrigins: ['https://accounts.google.com'],
  homeUrl: 'https://www.youtube.com/', loginUrl: 'https://accounts.google.com/ServiceLogin' };
const account = { platform: 'youtube', username: 'fixture@example.com', password: 'private-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };

// A page double: it records what the executor did and changes on interaction.
function page() {
  const state = { url: 'https://www.youtube.com/', text: 'Home', filled: [], clicks: 0,
    controls: [{ tag: 'button', type: '', label: 'Account menu', name: 'menu', enabled: true },
      { tag: 'input', type: 'text', label: 'Search', name: 'search', enabled: true }] };
  const element = control => ({ tagName: control.tag.toUpperCase(), id: '', innerText: control.label,
    labels: [], disabled: false, readOnly: false, required: false, form: null, href: '',
    getAttribute: name => (name === 'aria-label' ? control.label : name === 'type' ? control.type
      : name === 'name' ? control.name : null), querySelector: () => null });
  return { state, url: () => state.url,
    goto: async url => { state.url = url; return { status: () => 200 }; },
    goBack: async () => { state.url = 'https://www.youtube.com/'; },
    $$: async () => state.controls.map(control => ({
      isVisible: async () => true, isEnabled: async () => true, dispose: async () => {},
      evaluate: async fn => fn(element(control)),
      click: async () => { state.clicks++; state.text = `menu ${state.clicks}`; },
      fill: async value => { state.filled.push({ name: control.name, value }); } })),
    locator: () => ({ count: async () => 0, first() { return this; }, innerText: async () => state.text }),
    on: () => {}, off: () => {}, screenshot: async () => Buffer.from('png') };
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const receipts = createReceiptStore({ directory });
  const target = page();
  const vault = createEphemeralVault();
  const browser = {
    observe: async () => ({ url: target.state.url, text: target.state.text, fingerprint: `fp-${target.state.text}`,
      challengeFrame: false, controls: target.state.controls.map(control => ({ ...control,
        key: JSON.stringify([control.tag, control.type, control.name, control.label, '', '']),
        handle: null })) }),
    // The executor is the existing LoginBrowser surface, reduced to what MCP uses.
    execute: async (action, snapshot) => {
      const { control, kind } = action;
      if (kind === 'click_observed') { await control.handle.click(); return; }
      if (kind === 'type_observed') { await control.handle.fill(vault.resolve(action.valueRef)); return; }
      throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
    },
    navigate: async url => { target.state.url = url; },
  };
  // Give every observed control the live handle the executor needs.
  const liveObserve = async () => {
    const snapshot = await browser.observe();
    const handles = await target.$$();
    snapshot.controls.forEach((control, index) => { control.handle = handles[index]; });
    return snapshot;
  };
  const kernel = new BrowserExecutionKernel({ account, site, workflow: 'login', allowedRoles: mcpRoles,
    runId: 'mcp-run', receipts, observe: liveObserve,
    screenshot: async () => ({ base64: Buffer.from('png').toString('base64'), width: 800, height: 600, bytes: 3 }) });
  const toolset = createMcpToolset({ kernel, browser, page: target, site, observe: liveObserve, valueVault: vault });
  return { toolset, kernel, receipts, target, vault, server: createServer({ toolset }) };
}

test('the surface exposes exactly the eight documented tools', async t => {
  const { server } = await harness(t);
  const list = await server.handle({ id: 1, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map(tool => tool.name), mcpToolNames);
  assert.deepEqual(mcpToolNames, ['browser.observe', 'browser.screenshot', 'browser.click', 'browser.type',
    'browser.navigate', 'browser.back', 'browser.wait', 'browser.get_url']);
  // Every tool declares a closed schema: no free-form extra arguments.
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.equal(typeof tool.description, 'string');
  }
  const initialize = await server.handle({ id: 0, method: 'initialize' });
  assert.equal(initialize.result.protocolVersion, protocolVersion);
  assert.equal(initialize.result.serverInfo, serverInfo);
  assert.equal(await server.handle({ method: 'notifications/initialized' }), null);
  assert.equal((await server.handle({ id: 2, method: 'resources/list' })).error.code, -32601);
  const unknown = await server.handle({ id: 3, method: 'tools/call', params: { name: 'browser.evaluate' } });
  assert.equal(unknown.error.message, 'unknown_tool');
});

test('browser.observe and browser.screenshot read the epoch-bound state', async t => {
  const { toolset, kernel } = await harness(t);
  const observed = JSON.parse((await toolset.call('browser.observe')).content[0].text);
  assert.equal(observed.observationEpoch.length > 0, true);
  assert.equal(observed.url.origin, 'https://www.youtube.com');
  assert.deepEqual(observed.controls.map(control => control.id), ['e0', 'e1']);
  assert.equal(kernel.receipts.length, 0, 'reading never writes a receipt');

  const shot = await toolset.call('browser.screenshot');
  assert.equal(shot.content[0].type, 'text');
  assert.equal(shot.content[1].type, 'image');
  assert.equal(shot.content[1].mimeType, 'image/png');
  // Every read is its own epoch; the screenshot reports the epoch it captured.
  const shotEpoch = JSON.parse(shot.content[0].text).observationEpoch;
  assert.equal(typeof shotEpoch, 'string');
  assert.notEqual(shotEpoch, observed.observationEpoch);
});

test('every mutation is a BrowserAction through the kernel, with a receipt', async t => {
  const { toolset, kernel, target, receipts } = await harness(t);
  const observed = JSON.parse((await toolset.call('browser.observe')).content[0].text);

  const clicked = JSON.parse((await toolset.call('browser.click', { controlId: 'e0',
    observationEpoch: observed.observationEpoch })).content[0].text);
  assert.equal(clicked.operation, 'click_observed');
  assert.equal(clicked.receipt, 'verified', 'the postcondition was observed');
  assert.equal(target.state.clicks, 1);
  assert.equal(kernel.receipts.at(-1).action.risk, 'reversible_navigation');
  assert.equal(kernel.receipts.at(-1).action.observationEpoch, observed.observationEpoch);

  // Typing carries a reference, never the text itself.
  const typed = JSON.parse((await toolset.call('browser.type', { controlId: 'e1',
    observationEpoch: observed.observationEpoch, text: 'hello world' })).content[0].text);
  assert.match(typed.valueRef, /^operator_value_1$/);
  assert.equal(target.state.filled.at(-1).value, 'hello world');
  const disk = await readFile(receipts.path, 'utf8');
  assert.equal(disk.includes('hello world'), false, 'the value never reaches a receipt');
  assert.equal(disk.includes('operator_value_1'), true, 'only the reference does');
});

test('stale epochs, disallowed destinations and unknown tools are refused', async t => {
  const { toolset } = await harness(t);
  const observed = JSON.parse((await toolset.call('browser.observe')).content[0].text);

  await assert.rejects(toolset.call('browser.click', { controlId: 'e9',
    observationEpoch: observed.observationEpoch }), /stale_observation/);
  await assert.rejects(toolset.call('browser.click', { controlId: 'e0', observationEpoch: 'never-seen' }),
    /unknown_observation_epoch/);
  await assert.rejects(toolset.call('browser.navigate', { url: 'https://evil.example/collect' }),
    /unexpected_navigation_destination/);
  await assert.rejects(toolset.call('browser.type', { controlId: 'e1',
    observationEpoch: observed.observationEpoch, text: '' }), /invalid_text/);
  await assert.rejects(toolset.call('browser.evaluate', {}), /unknown_tool/);

  // A tool failure is a tool result with a code, never a protocol error.
  const server = createServer({ toolset });
  const failed = await server.handle({ id: 9, method: 'tools/call',
    params: { name: 'browser.click', arguments: { controlId: 'e9',
      observationEpoch: observed.observationEpoch } } });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.error, undefined);
});

test('the surface cannot authenticate or act consequentially', async t => {
  const { toolset, kernel } = await harness(t);
  assert.deepEqual(kernel.authorizedRoles(), ['read', 'navigate', 'prepare']);
  assert.equal(kernel.authorizedRoles().includes('authenticate'), false);
  assert.equal(kernel.authorizedRoles().includes('consequential'), false);
  assert.equal(kernel.permittedOperations().includes('submit_login'), false);
  assert.equal(kernel.permittedOperations().includes('click_observed'), true);

  // A navigation inside the allowed origins goes through the kernel like anything else.
  const navigated = JSON.parse((await toolset.call('browser.navigate',
    { url: 'https://www.youtube.com/feed' })).content[0].text);
  assert.equal(navigated.receipt, 'verified');
  const waited = JSON.parse((await toolset.call('browser.wait', { ms: 1 })).content[0].text);
  assert.equal(waited.waitedMs, 1);
  assert.equal(typeof waited.observationEpoch, 'string');
});
