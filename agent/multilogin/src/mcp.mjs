import { PilotError, requireThat } from './core.mjs';

// G4: a thin external surface. MCP is an access path, never the production loop:
// every tool goes through the SAME kernel (same authorization, epoch, receipt and
// postcondition pipeline), and this module contains almost no browser logic.
// No selectors, no arbitrary JavaScript, no shell.
export const mcpToolNames = ['browser.observe', 'browser.screenshot', 'browser.click', 'browser.type',
  'browser.navigate', 'browser.back', 'browser.wait', 'browser.get_url'];

// The external surface may read, navigate and prepare - never authenticate and
// never perform a consequential action.
export const mcpRoles = ['read', 'navigate', 'prepare'];

const target = { type: 'string', description: 'control id from the latest browser.observe epoch' };
const epoch = { type: 'string', description: 'observationEpoch returned by browser.observe' };

export const mcpTools = [
  { name: 'browser.observe', description: 'Read the current page: epoch, url, text and control ids.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'browser.screenshot', description: 'One viewport screenshot of the current page.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'browser.click', description: 'Click an observed control id from the current epoch.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['controlId', 'observationEpoch'],
      properties: { controlId: target, observationEpoch: epoch } } },
  { name: 'browser.type', description: 'Type text into an observed control id from the current epoch.',
    inputSchema: { type: 'object', additionalProperties: false,
      required: ['controlId', 'observationEpoch', 'text'],
      properties: { controlId: target, observationEpoch: epoch,
        text: { type: 'string', maxLength: 1000 } } } },
  { name: 'browser.navigate', description: 'Navigate to a url inside the configured allowed origins.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['url'],
      properties: { url: { type: 'string' } } } },
  { name: 'browser.back', description: 'Go back in the current page history.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'browser.wait', description: 'Wait briefly, then re-observe.',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { ms: { type: 'integer', minimum: 0, maximum: 10000 } } } },
  { name: 'browser.get_url', description: 'Return the current url only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
];

const text = value => ({ content: [{ type: 'text',
  text: typeof value === 'string' ? value : JSON.stringify(value) }] });

// The toolset holds no browser authority of its own: every mutation is a
// BrowserAction that the kernel authorizes, receipts and verifies.
export function createMcpToolset({ kernel, browser, page = null, site = null, observe = null,
  valueVault = null, roles = mcpRoles } = {}) {
  requireThat(kernel, 'mcp_kernel_required');
  requireThat(browser && typeof browser.observe === 'function', 'mcp_browser_required');
  const read = observe || (() => browser.observe());
  // Observations a caller may still quote. A read records its epoch; a mutation
  // must quote a known epoch and is then re-verified LIVE by the kernel before it
  // is dispatched, so an aged epoch fails closed instead of acting on a stale ref.
  const seen = new Map();
  const examine = async () => {
    const snapshot = await read();
    const observation = kernel.observe(snapshot).observation;
    seen.set(observation.epoch, { snapshot, observation });
    while (seen.size > 8) seen.delete(seen.keys().next().value);
    return { snapshot, observation };
  };
  // The surface runs with these roles only; the kernel enforces them.
  kernel.allowedRoles = [...roles];

  // A mutation may quote any epoch this surface actually produced; the kernel then
  // re-reads the page and fails closed if the reference aged out.
  const quoted = async observationEpoch => {
    const known = seen.get(observationEpoch);
    requireThat(known, 'unknown_observation_epoch');
    return known;
  };
  const observedControl = ({ snapshot, observation, controlId }) => {
    const index = observation.controls.findIndex(control => control.id === controlId);
    requireThat(index >= 0 && snapshot.controls[index], 'stale_observation');
    return snapshot.controls[index];
  };

  const tools = {
    'browser.get_url': async () => text({ url: page?.url?.() ?? null }),
    'browser.observe': async () => {
      const { snapshot, observation } = await examine();
      return text({ observationEpoch: observation.epoch,
        expiresAt: new Date(observation.expiresAt).toISOString(),
        url: { origin: observation.url.origin, pathname: observation.url.pathname },
        controls: observation.controls.slice(0, 80).map(control => ({ id: control.id,
          role: control.role, name: control.name, enabled: control.enabled })),
        text: String(snapshot.text ?? '').slice(0, 4000) });
    },
    'browser.screenshot': async () => {
      const { observation } = await examine();
      const shot = await kernel.screenshotFor({ observation });
      if (!shot || shot.skipped || !shot.base64) {
        return text({ screenshot: 'skipped', reason: shot?.skipped || 'unavailable' });
      }
      return { content: [
        { type: 'text', text: JSON.stringify({ observationEpoch: observation.epoch,
          width: shot.width ?? null, height: shot.height ?? null, bytes: shot.bytes ?? null }) },
        { type: 'image', data: shot.base64, mimeType: 'image/png' },
      ] };
    },
    'browser.click': async ({ controlId, observationEpoch }) => {
      const { snapshot, observation } = await quoted(observationEpoch);
      const control = observedControl({ snapshot, observation, controlId });
      const outcome = await kernel.execute({ candidate: { kind: 'click_observed', control }, snapshot,
        observation, source: 'operator',
        dispatch: async ({ control: live }) => {
          await browser.execute({ kind: 'click_observed', control: live || control, clickKey: null }, snapshot);
        } });
      return text({ receipt: outcome.receipt.state, operation: outcome.action.operation,
        controlId: outcome.action.controlId, observationEpoch: outcome.action.observationEpoch,
        postconditionMet: outcome.receipt.postconditionMet });
    },
    'browser.type': async ({ controlId, observationEpoch, text: value }) => {
      requireThat(typeof value === 'string' && value.length > 0 && value.length <= 1000, 'invalid_text');
      requireThat(valueVault && typeof valueVault.register === 'function', 'mcp_value_vault_required');
      const { snapshot, observation } = await quoted(observationEpoch);
      const control = observedControl({ snapshot, observation, controlId });
      // The value is registered as a reference; only the reference is recorded.
      const candidate = { kind: 'type_observed', control, valueRef: valueVault.register(value) };
      const outcome = await kernel.execute({ candidate, snapshot, observation, source: 'operator',
        expectedPostcondition: null,
        dispatch: async ({ control: live }) => {
          await browser.execute({ kind: 'type_observed', control: live || control,
            valueRef: candidate.valueRef, value: null }, snapshot);
        } });
      return text({ receipt: outcome.receipt.state, valueRef: outcome.action.valueRef });
    },
    'browser.navigate': async ({ url }) => {
      const parsed = new URL(url);
      requireThat(site?.origins?.includes(parsed.origin), 'unexpected_navigation_destination');
      const { snapshot, observation } = await examine();
      const outcome = await kernel.execute({ candidate: { kind: 'navigate_observed', destination: url },
        snapshot, observation, source: 'operator', expectedPostcondition: null,
        dispatch: async () => { await browser.navigate(url); } });
      return text({ receipt: outcome.receipt.state, url });
    },
    'browser.back': async () => {
      requireThat(page && typeof page.goBack === 'function', 'mcp_page_required');
      await page.goBack();
      const { observation } = await examine();
      return text({ url: page.url(), observationEpoch: observation.epoch });
    },
    'browser.wait': async ({ ms = 1000 } = {}) => {
      const waited = Math.min(Math.max(Number(ms) || 0, 0), 10000);
      await new Promise(resolve => setTimeout(resolve, waited));
      const { observation } = await examine();
      return text({ waitedMs: waited, observationEpoch: observation.epoch });
    },
  };

  return {
    tools,
    async call(name, args = {}) {
      requireThat(mcpToolNames.includes(name), 'unknown_tool');
      try { return await tools[name](args); }
      catch (error) {
        // A tool failure is reported as a code, never as page or credential content.
        const code = error instanceof PilotError ? error.code : 'tool_failed';
        // The code is what a caller may match on; the short detail helps diagnose a
        // tool failure without exposing page or credential content to the protocol.
        throw Object.assign(new Error(code), { code, detail: String(error?.message || '').slice(0, 120) });
      }
    },
  };
}
