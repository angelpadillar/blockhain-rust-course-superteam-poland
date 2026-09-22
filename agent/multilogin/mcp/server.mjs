// G4: the smallest MCP server over stdio. It is an external access surface, not
// the production loop: it exposes the toolset, which calls the SAME kernel.
// JSON-RPC 2.0 over newline-delimited stdio, no dependency, no HTTP, no webhook.
//
//   node mcp/server.mjs            (speaks MCP on stdin/stdout)
//
// The caller supplies a toolset via createServer({ toolset }); the CLI entry below
// builds one only when a browser session is already attached by the runtime.
import { createInterface } from 'node:readline';
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

// Only run as a server when executed directly; importing it stays side-effect free.
if (process.argv[1]?.endsWith('mcp/server.mjs')) {
  const { createMcpToolset } = await import('../src/mcp.mjs');
  const toolset = globalThis.__browserToolset || null;
  if (!toolset) process.stderr.write('mcp: no browser toolset attached; tools return browser_not_attached\n');
  await createServer({ toolset }).serve();
}
