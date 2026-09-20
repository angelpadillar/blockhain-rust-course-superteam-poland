import { spawn, execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function startDisplay({ desktop = false } = {}) {
  process.env.DISPLAY = ':99'; const children = [];
  const stop = () => { for (const child of children.reverse()) child.kill('SIGTERM'); };
  const start = (name, args) => { const child = spawn(name, args, { stdio: 'ignore', env: process.env }); children.push(child); child.on('error', () => {}); return child; };
  const xvfb = start('Xvfb', [':99', '-screen', '0', '1440x1000x24', '-nolisten', 'tcp']);
  let ready = false;
  for (let i = 0; i < 50; i++) {
    if (xvfb.exitCode !== null) break;
    try { await access('/tmp/.X11-unix/X99'); ready = true; break; } catch {}
    await delay(100);
  }
  if (!ready) { stop(); throw new Error('Private display did not start'); }
  start('fluxbox', []);
  if (desktop) {
    const passwordFile = process.env.VNC_PASSWORD_FILE || '/run/secrets/vnc_password';
    try { await access(passwordFile); } catch { stop(); throw new Error('VNC password file missing'); }
    // X11 PRIMARY is merely highlighted text. Only explicit CLIPBOARD copies
    // should be sent back to noVNC, otherwise a selected URL fragment wins.
    start('x11vnc', ['-display', ':99', '-localhost', '-forever', '-shared', '-noprimary', '-rfbauth', passwordFile, '-rfbport', '5900']);
    start('websockify', ['--web=/usr/share/novnc', '6080', '127.0.0.1:5900']);
  }
  return stop;
}
export async function maximizeBrowser() {
  const { stdout } = await exec('wmctrl', ['-lx']);
  const windows = stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(parts => /^0x[0-9a-f]+$/i.test(parts[0] || '') && /camoufox|firefox/i.test(parts[2] || ''));
  for (const parts of windows) await exec('wmctrl', ['-i', '-r', parts[0], '-b', 'add,maximized_vert,maximized_horz']);
  return windows.length;
}
