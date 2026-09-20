import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { McpClient, pngBytes, structured } from '../src/mcp.mjs';

function fixtureProcess() {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.requests = [];
  child.stdin = new Writable({ write(chunk, encoding, done) { const message = JSON.parse(chunk.toString()); child.requests.push(message); done(); } });
  child.kill = () => child.emit('exit', 0); return child;
}
test('MCP client handles fragmented and interleaved JSON-RPC responses', async () => {
  const child = fixtureProcess(); const client = new McpClient([], { spawnImpl: () => child });
  const first = client.request('first'); const second = client.request('second');
  child.stdout.write('{"jsonrpc":"2.0","id":2,"result":{"b":');
  child.stdout.write('2}}\n{"jsonrpc":"2.0","id":1,"result":{"a":1}}\n');
  assert.deepEqual(await first, { a: 1 }); assert.deepEqual(await second, { b: 2 }); child.kill();
});
test('client rejects fields absent from the live contract before any tool dispatch', async () => {
  const child = fixtureProcess(); const client = new McpClient([], { spawnImpl: () => child });
  client.tools = [{ name: 'browser_snapshot', inputSchema: { properties: { session_id: {} } } }];
  await assert.rejects(client.call('browser_snapshot', { session_id: 'ok', script: 'secret' }), /Unexpected input/);
  await assert.rejects(client.call('browser_evaluate', {}), /unavailable/);
  assert.equal(child.requests.length, 0); child.kill();
});
test('malformed upstream protocol ends pending operations instead of interpreting output', async () => {
  const child = fixtureProcess(); const client = new McpClient([], { spawnImpl: () => child });
  const result = client.request('first'); child.stdout.write('not JSON\n');
  await assert.rejects(result); assert(client.closed);
});
test('screenshots must contain an actual PNG signature', () => {
  assert.throws(() => pngBytes({ content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not PNG').toString('base64') }] }), /Invalid PNG/);
});
test('complete text JSON preserves a real-sized DOM omitted from upstream structuredContent', () => {
  const elements = Array.from({ length: 100 }, (_, i) => ({ ref: `e${i}`, role: 'button', name: `Distinct visible option ${i}` }));
  assert(Buffer.byteLength(JSON.stringify(elements)) > 4096);
  const actual = structured({ structuredContent: { url: 'https://captions.ai/home', _meta: { omitted: ['elements'] } }, content: [{ type: 'text', text: JSON.stringify({ url: 'https://captions.ai/home', elements }) }] });
  assert.deepEqual(actual.elements, elements);
});
test('per-call deadline makes shutdown requests bounded without retrying the action', async () => {
  const child = fixtureProcess(); const client = new McpClient([], { spawnImpl: () => child });
  client.tools = [{ name: 'session_destroy', inputSchema: { properties: { session_id: {} } } }];
  await assert.rejects(client.call('session_destroy', { session_id: 'fixture' }, { timeoutMs: 10 }), /timed out/);
  assert.equal(child.requests.length, 1); child.kill();
});
