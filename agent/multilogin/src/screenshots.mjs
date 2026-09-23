import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Screenshot evidence for state transitions. Never during credential entry: on
// a credential origin the capture is skipped while a password input is present
// in the page, so no entered value can be captured.
//
// A human-checkpoint screenshot has to be legible for a person: the current
// viewport is captured at the browser's native resolution as a PNG, with no
// intentional downscaling. A client-rendered page can classify as a checkpoint
// while its first frame is still blank or half-painted, so a caller may ask for
// a short BOUNDED settle (at most two animation frames plus a fixed delay) and a
// bounded retry when the captured frame is suspiciously small. Network-idle is
// never awaited, because a modern SPA may never reach it.
export async function captureSafeScreenshot({ page, directory, label, index = 0, credentialOrigins = [],
  settleMs = 0, minBytes = 0, attempts = 1 } = {}) {
  if (!page || typeof page.screenshot !== 'function') return { skipped: 'page_unavailable' };
  try {
    let origin = null;
    try { origin = new URL(page.url()).origin; } catch {}
    if (origin && credentialOrigins.includes(origin)) {
      const fields = await page.locator('input[type="password"]:visible').count().catch(() => 0);
      if (fields > 0) return { skipped: 'credential_entry_visible' };
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${String(index).padStart(2, '0')}-${label.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)}.png`;
    const path = resolve(directory, name);
    const tries = Math.max(1, Math.min(Number(attempts) || 1, 5));
    const settleWait = Math.max(0, Number(settleMs) || 0);
    const floor = Math.max(0, Number(minBytes) || 0);
    let bytes = 0;
    // Capture at most `tries` times. A frame below `minBytes` is treated as
    // blank/half-rendered and retried; the last attempt is always kept so a
    // genuinely sparse-but-real page is still recorded rather than discarded.
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (settleWait > 0) await settleForRender(page, settleWait);
      await page.screenshot({ path, fullPage: false });
      bytes = (await readFile(path).catch(() => null))?.length ?? 0;
      if (bytes >= floor || attempt === tries) return { path, name, bytes, attempts: attempt };
    }
    return { path, name, bytes, attempts: tries };
  } catch { return { skipped: 'screenshot_failed' }; }
}

// Bounded render settle: wait for one painted frame (two animation frames) and
// then a short fixed delay. Every step is time-bounded and best-effort, so a
// page double without these APIs still captures.
async function settleForRender(page, settleMs) {
  if (typeof page.evaluate === 'function') {
    await page.evaluate(() => new Promise(resolve => {
      if (typeof requestAnimationFrame !== 'function') return resolve();
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    })).catch(() => {});
  }
  if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(settleMs).catch(() => {});
  else await new Promise(resolve => setTimeout(resolve, settleMs));
}
