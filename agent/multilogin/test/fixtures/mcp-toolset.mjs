// A deterministic, offline browser fixture for the MCP compatibility test. The
// server imports this module through MCP_TOOLSET_MODULE, so the server stays free
// of fixture wiring and the production loop never goes through MCP.
import { BrowserExecutionKernel } from '../../src/execution.mjs';
import { createMcpToolset, mcpRoles } from '../../src/mcp.mjs';
import { createEphemeralVault } from '../../src/secrets.mjs';

const site = { origins: ['https://www.youtube.com'], credentialOrigins: ['https://accounts.google.com'],
  homeUrl: 'https://www.youtube.com/', loginUrl: 'https://accounts.google.com/ServiceLogin' };
const account = { platform: 'youtube', username: 'fixture@example.com', password: 'private-password',
  totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', id: 'fixture' };

function element(control) {
  return { tagName: control.tag.toUpperCase(), id: '', innerText: control.label, labels: [],
    disabled: false, readOnly: false, required: false, form: null, href: '',
    getAttribute: name => (name === 'aria-label' ? control.label : name === 'type' ? control.type
      : name === 'name' ? control.name : null),
    querySelector: () => null };
}

export function createToolset() {
  const state = { url: 'https://www.youtube.com/', text: 'Home', clicks: 0, filled: [],
    controls: [{ tag: 'button', type: '', label: 'Account menu', name: 'menu', enabled: true },
      { tag: 'input', type: 'text', label: 'Search', name: 'search', enabled: true }] };
  const page = { state,
    url: () => state.url,
    goto: async url => { state.url = url; return { status: () => 200 }; },
    goBack: async () => { state.url = 'https://www.youtube.com/'; },
    $$: async () => state.controls.map(control => ({
      isVisible: async () => true, isEnabled: async () => true, dispose: async () => {},
      evaluate: async fn => fn(element(control)),
      click: async () => { state.clicks++; state.text = `menu ${state.clicks}`; },
      fill: async value => { state.filled.push({ name: control.name, value }); } })),
    locator: () => ({ count: async () => 0, first() { return this; }, innerText: async () => state.text }),
    on: () => {}, off: () => {}, screenshot: async () => Buffer.from('png') };

  const vault = createEphemeralVault();
  const observe = async () => {
    const handles = await page.$$();
    return { url: state.url, text: state.text, fingerprint: `fp-${state.text}`, challengeFrame: false,
      controls: state.controls.map((control, index) => ({ ...control, key: `k${index}`,
        handle: handles[index] })) };
  };
  const browser = {
    observe,
    execute: async (action, snapshot) => {
      if (action.kind === 'click_observed') { await action.control.handle.click(); return; }
      if (action.kind === 'type_observed') {
        await action.control.handle.fill(vault.resolve(action.valueRef)); return;
      }
      throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
    },
    navigate: async url => { state.url = url; },
  };
  const kernel = new BrowserExecutionKernel({ account, site, workflow: 'mcp', allowedRoles: mcpRoles,
    runId: 'mcp-fixture', observe,
    screenshot: async () => ({ base64: Buffer.from('png').toString('base64'), width: 800, height: 600,
      bytes: 3 }) });
  return createMcpToolset({ kernel, browser, page, site, observe, valueVault: vault });
}
