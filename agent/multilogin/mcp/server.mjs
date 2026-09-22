// G4: the smallest MCP server over stdio. It is an external access surface, not
// the production loop: it exposes the toolset, which calls the SAME kernel.
// JSON-RPC 2.0 over newline-delimited stdio, no dependency, no HTTP, no webhook.
//
//   node mcp/server.mjs            (speaks MCP on stdin/stdout)
//
// The caller supplies a toolset via createServer({ toolset }); the CLI entry below
// builds one only when a browser session is already attached by the runtime.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { mcpToolNames, mcpTools } from '../src/mcp.mjs';

export const protocolVersion = '2024-11-05';
export const serverInfo = { name: 'multilogin-browser-kernel', version: '0.1.0' };

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: false });

export function createServer({ toolset, write = line => process.stdout.write(`${JSON.stringify(line)}\n`) } = {}) {
  const handle = async request => {
    const { id = null, method, params = {} } = request || {};
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion,
        capabilities: { tools: { listChanged: false } }, serverInfo } };
    }
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return null;
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: mcpTools.map(tool => ({ name: tool.name,
        description: tool.description, inputSchema: tool.inputSchema })) } };
    }
    if (method === 'tools/call') {
      const name = params.name;
      if (!mcpToolNames.includes(name)) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown_tool' } };
      }
      if (!toolset) {
        return { jsonrpc: '2.0', id, result: { ...text('browser_not_attached'), isError: true } };
      }
      try {
        return { jsonrpc: '2.0', id, result: { ...await toolset.call(name, params.arguments || {}), isError: false } };
      } catch (error) {
        // A failure is a tool result, not a protocol error, and carries only a code.
        return { jsonrpc: '2.0', id, result: { ...text(error?.code || 'tool_failed'), isError: true } };
      }
    }
    if (id === null) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported_method:${method}` } };
  };

  return {
    handle,
    async serve({ input = process.stdin } = {}) {
      const lines = createInterface({ input, terminal: false });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); }
        catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse_error' } }); continue; }
        const response = await handle(request);
        if (response) write(response);
      }
    },
  };
}

// A browser session is attached from outside: either in-process via
// globalThis.__browserToolset, or by naming a module that exports createToolset()
// (MCP_TOOLSET_MODULE). The server itself contains no browser logic and no fixture
// wiring, so the production loop never goes through MCP.
async function attachedToolset() {
  if (globalThis.__browserToolset) return globalThis.__browserToolset;
  const modulePath = process.env.MCP_TOOLSET_MODULE;
  if (!modulePath) return null;
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createToolset !== 'function') {
    throw new Error('MCP_TOOLSET_MODULE must export createToolset()');
  }
  return module.createToolset();
}

// Only run as a server when executed directly; importing it stays side-effect free.
if (process.argv[1]?.endsWith('mcp/server.mjs')) {
  let toolset = null;
  try { toolset = await attachedToolset(); }
  catch (error) { process.stderr.write(`mcp: toolset module failed: ${error.message}\n`); }
  if (!toolset) process.stderr.write('mcp: no browser toolset attached; tools return browser_not_attached\n');
  await createServer({ toolset }).serve();
}
