import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

// STEP 5: interoperability with a REAL MCP client, not just a hand-rolled call to
// the server's own handler. The official @modelcontextprotocol/sdk client is used
// when it is available locally (MCP_SDK_PATH, an installed dependency, or one of
// the known local checkouts); otherwise the test skips with a clear reason.
const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'mcp', 'server.mjs');
const toolsetPath = join(here, 'fixtures', 'mcp-toolset.mjs');

const sdkCandidates = [
  process.env.MCP_SDK_PATH ? join(process.env.MCP_SDK_PATH, 'dist/esm/client/index.js') : null,
  join(here, '..', 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'),
  '/tmp/mcp-sdk/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
  '/Users/buena/Code/buena-mail-app/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js',
].filter(Boolean);

function sdkRoot() {
  for (const candidate of sdkCandidates) {
    if (existsSync(candidate)) return candidate.replace(/dist\/esm\/client\/index\.js$/, '');
  }
  return null;
}

async function connect() {
  const root = sdkRoot();
  const { Client } = await import(pathToFileURL(join(root, 'dist/esm/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(join(root, 'dist/esm/client/stdio.js')).href);
  const child = spawn(process.execPath, [serverPath], { env: { ...process.env,
    MCP_TOOLSET_MODULE: toolsetPath }, stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString()));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath],
    env: { ...process.env, MCP_TOOLSET_MODULE: toolsetPath }, stderr: 'pipe' });
  const client = new Client({ name: 'kernel-compat-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return { client, child, stderr, transport,
    close: async () => { await client.close().catch(() => {}); child.kill('SIGKILL'); } };
}

const textOf = result => (result.content || []).filter(item => item.type === 'text')
  .map(item => item.text).join('\n');

test('a real MCP client can discover tools, observe, screenshot and mutate', async t => {
  if (!sdkRoot()) {
    t.skip('no @modelcontextprotocol/sdk available locally; set MCP_SDK_PATH to run the compatibility test');
    return;
  }
  const session = await connect();
  t.after(() => session.close());

  // 1. discovery
  const listed = await session.client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['browser.back', 'browser.click',
    'browser.get_url', 'browser.navigate', 'browser.observe', 'browser.screenshot', 'browser.type',
    'browser.wait']);

  // 2. observe
  const observed = JSON.parse(textOf(await session.client.callTool({ name: 'browser.observe',
    arguments: {} })));
  assert.equal(observed.url.origin, 'https://www.youtube.com');
  assert.deepEqual(observed.controls.map(control => control.id), ['e0', 'e1']);
  assert.equal(typeof observed.observationEpoch, 'string');

  // 3. screenshot: image content a model can consume, plus safe metadata
  const shot = await session.client.callTool({ name: 'browser.screenshot', arguments: {} });
  const image = (shot.content || []).find(item => item.type === 'image');
  assert.equal(Boolean(image), true, 'the client receives image content');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(typeof image.data, 'string');

  // 4. one harmless typed mutation, through the kernel like any other action
  const typed = JSON.parse(textOf(await session.client.callTool({ name: 'browser.type',
    arguments: { controlId: 'e1', observationEpoch: observed.observationEpoch, text: 'harmless' } })));
  assert.equal(typed.receipt, 'verified');
  assert.match(typed.valueRef, /^operator_value_/);

  const url = JSON.parse(textOf(await session.client.callTool({ name: 'browser.get_url', arguments: {} })));
  assert.equal(url.url, 'https://www.youtube.com/');
});

test('a real MCP client cannot smuggle a selector, script or stale epoch', async t => {
  if (!sdkRoot()) {
    t.skip('no @modelcontextprotocol/sdk available locally; set MCP_SDK_PATH to run the compatibility test');
    return;
  }
  const session = await connect();
  t.after(() => session.close());
  const observed = JSON.parse(textOf(await session.client.callTool({ name: 'browser.observe',
    arguments: {} })));

  // A selector or script field is refused: the tools accept only their own fields.
  for (const arguments_ of [{ selector: '#submit' }, { script: 'document.forms[0].submit()' },
    { url: 'https://evil.example' }]) {
    const rejected = await session.client.callTool({ name: 'browser.click',
      arguments: { controlId: 'e0', observationEpoch: observed.observationEpoch, ...arguments_ } });
    assert.equal(rejected.isError, true, JSON.stringify(arguments_));
    assert.match(textOf(rejected), /unknown_tool_argument/);
  }

  // An unknown tool is a PROTOCOL error (the SDK client raises it), which is the
  // documented distinction from a tool-level failure that comes back as isError.
  await assert.rejects(session.client.callTool({ name: 'browser.evaluate', arguments: {} }),
    error => error.code === -32602 && /unknown_tool/.test(error.message));

  // A stale epoch and a disallowed destination are tool-level failures.
  const stale = await session.client.callTool({ name: 'browser.click', arguments: { controlId: 'e0',
    observationEpoch: 'epoch-that-was-never-observed' } });
  assert.equal(stale.isError, true);
  assert.match(textOf(stale), /unknown_observation_epoch/);
  const foreign = await session.client.callTool({ name: 'browser.navigate',
    arguments: { url: 'https://evil.example/collect' } });
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /unexpected_navigation_destination/);
});
