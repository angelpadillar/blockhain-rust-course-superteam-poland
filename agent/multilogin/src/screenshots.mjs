import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Screenshot evidence for state transitions. Never during credential entry: on
// a credential origin the capture is skipped while a password input is present
// in the page, so no entered value can be captured.
export async function captureSafeScreenshot({ page, directory, label, index = 0, credentialOrigins = [] }) {
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
    await page.screenshot({ path, fullPage: false });
    return { path, name };
  } catch { return { skipped: 'screenshot_failed' }; }
}
