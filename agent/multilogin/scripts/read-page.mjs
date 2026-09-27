import { requireThat } from '../src/core.mjs';
import { loadPlaywright } from '../src/runner.mjs';

// Read the newest page's URL + visible text from an ALREADY-RUNNING profile
// (diagnostic; never clicks, never closes tabs).
//
// Usage: node scripts/read-page.mjs --port <cdp-port> [--chars 600]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--port', '--chars'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      requireThat(typeof value === 'string' && !value.startsWith('--'), 'invalid_command_arguments');
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const port = Number(options.port);
  requireThat(Number.isInteger(port) && port > 0, 'port_required');
  const chars = Number(options.chars || 600);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const context = browser.contexts()[0];
  requireThat(context, 'missing_context');
  const pages = context.pages().filter((candidate) => !candidate.isClosed());
  const out = [];
  for (const page of pages.slice(-4)) {
    out.push({
      url: page.url().split('?')[0],
      title: await page.title().catch(() => null),
      text: (await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '')).slice(0, chars),
    });
  }
  console.log(JSON.stringify({ pages: out }, null, 2));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error) }));
    process.exit(2);
  });
}
