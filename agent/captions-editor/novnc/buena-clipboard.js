import UI from './ui.js';

// User-driven plain-text transfer through noVNC's existing authenticated RFB
// connection. No clipboard reads, storage, logging, or additional network API.
const button = document.createElement('button');
button.id = 'buena_clipboard_open'; button.type = 'button'; button.textContent = 'Copy / Paste';
button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'buena_clipboard_panel');
const panel = document.createElement('section');
panel.id = 'buena_clipboard_panel'; panel.hidden = true; panel.setAttribute('aria-label', 'Copy and paste with VPS');
panel.innerHTML = `<header><strong>Copy &amp; paste</strong><button type="button" id="buena_clipboard_close" aria-label="Close copy and paste">×</button></header>
  <label for="buena_clipboard_out">Your device → VPS</label>
  <p>Paste text below using <b>⌘V</b> on Mac or <b>Ctrl+V</b> on Windows.</p>
  <textarea id="buena_clipboard_out" rows="3" spellcheck="false" placeholder="Paste a URL or other text here"></textarea>
  <button type="button" id="buena_clipboard_send">Send to VPS</button>
  <p>Then click the field inside the remote browser and press <b>Ctrl+V</b> (also on Mac).</p>
  <hr><label for="buena_clipboard_in">VPS → your device</label>
  <p>Inside the remote browser, select text and press <b>Ctrl+C</b>. It appears below.</p>
  <textarea id="buena_clipboard_in" rows="3" readonly spellcheck="false" placeholder="Text copied inside the VPS appears here"></textarea>
  <button type="button" id="buena_clipboard_copy">Copy to device</button>
  <p>Then paste on your own device with <b>⌘V</b> or <b>Ctrl+V</b>.</p>
  <p id="buena_clipboard_status" role="status" aria-live="polite">Connect to the desktop to transfer text.</p>`;
document.body.append(button, panel);
const outgoing = document.getElementById('buena_clipboard_out');
const incoming = document.getElementById('buena_clipboard_in');
const status = document.getElementById('buena_clipboard_status');
const send = document.getElementById('buena_clipboard_send');
const copy = document.getElementById('buena_clipboard_copy');
let attached = null;
function open(value) {
  panel.hidden = !value; button.setAttribute('aria-expanded', String(value));
  if (value) { UI.rfb?.blur(); outgoing.focus(); } else button.focus();
}
button.addEventListener('click', () => open(panel.hidden));
document.getElementById('buena_clipboard_close').addEventListener('click', () => open(false));
panel.addEventListener('keydown', event => { if (event.key === 'Escape') open(false); });
function receive(event) {
  if (typeof event.detail?.text !== 'string') return;
  incoming.value = event.detail.text;
  status.textContent = 'Text received from VPS. Choose Copy to device.';
}
function connect() {
  if (attached !== UI.rfb) {
    attached?.removeEventListener('clipboard', receive); attached = UI.rfb || null;
    attached?.addEventListener('clipboard', receive);
  }
  send.disabled = !(UI.connected && attached && !attached.viewOnly);
}
connect(); setInterval(connect, 500);
send.addEventListener('click', () => {
  connect(); if (send.disabled) return;
  attached.clipboardPasteFrom(outgoing.value);
  status.textContent = 'Sent to VPS clipboard. Click the remote field, then press Ctrl+V.';
});
copy.addEventListener('click', async () => {
  UI.rfb?.blur(); incoming.focus(); incoming.select();
  let copied = false;
  // HTTP origins do not expose the Async Clipboard API. The explicit user
  // gesture permits the legacy copy operation in supporting browsers.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(incoming.value); copied = true; } catch {}
  }
  if (!copied) { try { copied = document.execCommand('copy'); } catch {} }
  status.textContent = copied ? 'Copied to your device.' : 'Text selected. Press ⌘C on Mac or Ctrl+C on Windows, then paste on your device.';
});
