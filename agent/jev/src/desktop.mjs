import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { onboard } from './onboard.mjs';
import { setupPage, setupErrorMessage } from './setup.mjs';

process.env.DISPLAY = ':99';
const children = []; let setup, http, stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  http?.close();
  await setup?.session.close().catch(() => {});
  await setup?.release();
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}
function start(command, args) {
  const child = spawn(command, args, { stdio: 'ignore' }); children.push(child);
  child.on('error', () => void stop(1));
  child.on('exit', () => { if (!stopping) void stop(1); });
}
try {
  start('Xvfb', [':99', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp']);
  await new Promise(resolve => setTimeout(resolve, 700));
  start('fluxbox', []);
  start('x11vnc', ['-display', ':99', '-localhost', '-forever', '-shared', '-nopw', '-rfbport', '5900']);
  start('websockify', ['--web=/usr/share/novnc', '6080', '127.0.0.1:5900']);
  setup = await onboard({ desktop: true });
  const nonce = randomBytes(24).toString('hex');
  http = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    if (req.method === 'GET' && req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      try { return res.end(setupPage(await setup.refresh(), nonce)); }
      catch { res.statusCode = 503; return res.end('The test configuration is unavailable. Restore its settings and reload this page.'); }
    }
    if (req.method === 'POST' && req.url === `/finish?token=${nonce}`) {
      try {
        const checks = await setup.finish();
        res.end(checks.storeReady ? 'Account setup saved. The configured store and empty basket were also verified. You can close this tab.'
          : 'Account setup saved. Your home address and signed-in account are verified. Store availability and the basket will be checked before the first shopping job. You can close this tab.');
        setTimeout(() => void stop(), 300);
      } catch (error) {
        res.statusCode = 409;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(setupPage(setup.settings.config, nonce, setupErrorMessage(error)));
      }
      return;
    }
    res.statusCode = 404; res.end();
  });
  http.listen(6081, '0.0.0.0');
  console.log('Private onboarding is available on ports 6080 (browser) and 6081 (finish setup). Use only a private Tailscale connection or SSH forwarding.');
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
} catch { console.error('desktop_onboarding_failed'); await stop(1); }
