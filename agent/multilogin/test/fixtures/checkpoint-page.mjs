// A synthetic page a person has to read after a checkpoint, plus the tiny PNG
// helpers the fidelity test and the live diagnostic script share. It is a normal
// web page with large text, small text, buttons, an input and a fine one-pixel
// pattern. It is never a CAPTCHA and it provokes no real challenge.
import { createHash } from 'node:crypto';

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const VIEWPORT = { width: 1280, height: 720 };

export const FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #fff; font-family: sans-serif; color: #111; }
  h1 { font-size: 44px; margin: 16px; }
  p { font-size: 11px; margin: 8px 16px; width: 900px; }
  button { font-size: 14px; margin: 8px 16px; }
  input { font-size: 14px; margin: 8px 16px; width: 320px; }
  .fine { margin: 16px; width: 640px; height: 180px; background:
    repeating-linear-gradient(90deg, #000 0 1px, #fff 1px 2px),
    repeating-linear-gradient(0deg, #fff 0 1px, #000 1px 2px); }
</style></head><body>
  <h1>Verify this account</h1>
  <p>Small detail line one: the operator has to read this on a phone after Telegram transport,
     so every character above and below must stay legible at the native browser resolution.</p>
  <p>Small detail line two: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz</p>
  <p>Small detail line three: the fine pattern underneath is one pixel wide, so any downscale or
     recompression is visible as moire rather than as readable text.</p>
  <button>Continue</button> <button>Cancel</button>
  <div><input value="sample input value" aria-label="sample field"></div>
  <div class="fine"></div>
</body></html>`;

// A frame with no content, used to prove the fixture frame carries real detail.
export const BLANK_HTML = '<!doctype html><html><head><meta charset="utf-8"></head>'
  + '<body style="margin:0;background:#fff"></body></html>';

// PNG header read without a decoder dependency: dimensions, bit depth and colour
// type are all in the IHDR chunk.
export function pngInfo(buffer) {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20),
    bitDepth: buffer[24], colorType: buffer[25] };
}

export const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
