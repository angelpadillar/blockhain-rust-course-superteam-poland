import { spawn } from 'node:child_process';

// The upstream protocol is newline-delimited JSON-RPC. This client is private to
// this process; it is deliberately not an arbitrary browser HTTP endpoint.
export class McpClient {
  constructor(args, { binary = 'gomoufox', spawnImpl = spawn, timeoutMs = 120000 } = {}) {
    this.timeoutMs = timeoutMs; this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.closed = false; this.exited = false;
    this.child = spawnImpl(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    // Upstream stderr may contain URLs. Do not log it or persist authentication data.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(new Error('MCP input stream failed')));
    this.child.on('error', () => this.fail(new Error('gomoufox could not start')));
    this.child.on('exit', code => { this.exited = true; this.fail(new Error(`gomoufox exited (${code})`)); });
  }
  fail(error) {
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 16 * 1024 * 1024) { this.child.kill('SIGTERM'); this.fail(new Error('Oversized MCP response')); return; }
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.child.kill('SIGTERM'); this.fail(new Error('Invalid MCP response')); return; }
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`MCP protocol error ${message.error.code}`));
      else entry.resolve(message.result);
    }
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.closed) return Promise.reject(new Error('MCP client is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out; no automatic retry`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async initialize() {
    const init = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buena-captions-candidate', version: '0.1.0' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.tools = (await this.request('tools/list')).tools;
    if (!Array.isArray(this.tools)) throw new Error('Missing live MCP tool contract');
    return init;
  }
  requireTools(names) {
    for (const name of names) if (!this.tools?.some(tool => tool.name === name)) throw new Error(`Required upstream tool unavailable: ${name}`);
  }
  async call(name, args = {}, { timeoutMs = this.timeoutMs } = {}) {
    this.requireTools([name]);
    const schema = this.tools.find(tool => tool.name === name).inputSchema;
    for (const key of Object.keys(args)) if (!schema?.properties?.[key]) throw new Error(`Unexpected input field for ${name}: ${key}`);
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (result?.isError) {
      // Save no arbitrary provider message: it can include login links or codes.
      const detail = structured(result);
      const reasons = new Set(['network_policy', 'evaluation_interrupted', 'runtime', 'profile_in_use', 'launch', 'closed', 'stale_ref', 'ambiguous_selector', 'frame', 'timeout', 'canceled', 'selector', 'network', 'script', 'unknown']);
      const reason = reasons.has(detail.reason) ? detail.reason : 'unknown';
      const code = typeof detail.error === 'string' && /^[a-z_]{1,60}$/.test(detail.error) ? detail.error : 'tool_error';
      const error = new Error(`${name} failed: ${code}/${reason}`);
      error.browserFailure = { tool: name, code, reason }; throw error;
    }
    return result;
  }
  async close() {
    if (this.exited) return;
    this.child.stdin.end();
    if (!(await this.waitForExit(1000))) {
      this.child.kill('SIGTERM');
      if (!(await this.waitForExit(1500))) { this.child.kill('SIGKILL'); await this.waitForExit(1000); }
    }
    this.fail(new Error('MCP client closed'));
  }
  waitForExit(ms) {
    if (this.exited) return Promise.resolve(true);
    return new Promise(resolve => {
      const onExit = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { this.child.removeListener('exit', onExit); resolve(false); }, ms);
      this.child.once('exit', onExit);
    });
  }
}
export function structured(result) {
  // gomoufox omits structured fields over 4 KiB. The text JSON is its complete
  // payload, including a real-page DOM snapshot that can exceed that threshold.
  const text = result?.content?.find(item => item.type === 'text')?.text;
  try { if (text) return JSON.parse(text); } catch {}
  return result?.structuredContent || {};
}
export function pngBytes(result) {
  const item = result?.content?.find(item => item.type === 'image' && item.mimeType === 'image/png');
  if (!item) throw new Error('Upstream returned no PNG screenshot');
  const bytes = Buffer.from(item.data, 'base64');
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG image');
  return bytes;
}
