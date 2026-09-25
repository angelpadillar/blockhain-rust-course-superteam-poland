import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
//
// `bundle: true` adds deterministic context for the human: the full-page frame,
// a focused challenge-region frame when one is detectable, and a JSON sidecar
// with url (origin+path), title, visible-text summary, viewport, device pixel
// ratio, timestamp and job/profile identity. The canonical viewport PNG keeps
// its name and bytes: a bundle never replaces or re-encodes it.
export async function captureSafeScreenshot({ page, directory, label, index = 0, credentialOrigins = [],
  settleMs = 0, minBytes = 0, attempts = 1, bundle = false, context = null, redact = null } = {}) {
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
    let usedAttempt = tries;
    // Capture at most `tries` times. A frame below `minBytes` is treated as
    // blank/half-rendered and retried; the last attempt is always kept so a
    // genuinely sparse-but-real page is still recorded rather than discarded.
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (settleWait > 0) await settleForRender(page, settleWait);
      await page.screenshot({ path, fullPage: false });
      bytes = (await readFile(path).catch(() => null))?.length ?? 0;
      if (bytes >= floor || attempt === tries) { usedAttempt = attempt; break; }
    }
    const result = { path, name, bytes, attempts: usedAttempt };
    if (bundle) Object.assign(result, await captureBundle({ page, directory, name, context, redact, origin }));
    return result;
  } catch { return { skipped: 'screenshot_failed' }; }
}

// The extra frames and the sidecar are best-effort: a page double or a browser
// without fullPage support still leaves the canonical screenshot intact.
async function captureBundle({ page, directory, name, context, redact, origin }) {
  const base = name.replace(/\.png$/, '');
  const bundle = { capturedAt: new Date().toISOString(), fullPage: false, diagnostics: [] };
  try {
    const fullPath = resolve(directory, `${base}-full.png`);
    await page.screenshot({ path: fullPath, fullPage: true });
    bundle.fullPath = fullPath; bundle.fullName = `${base}-full.png`; bundle.fullPage = true;
  } catch { bundle.diagnostics.push('full_page_capture_failed'); }
  const region = await detectChallengeRegion(page);
  if (region?.clip) {
    try {
      const regionPath = resolve(directory, `${base}-region.png`);
      await page.screenshot({ path: regionPath, clip: region.clip });
      bundle.regionPath = regionPath; bundle.regionName = `${base}-region.png`;
      bundle.regionSelector = region.selector;
    } catch { bundle.diagnostics.push('region_capture_failed'); }
  } else bundle.diagnostics.push('challenge_region_not_detected');
  const safe = value => (redact ? redact(String(value ?? '')) : String(value ?? ''));
  const pageContext = {};
  try {
    const url = new URL(page.url());
    pageContext.url = `${url.origin}${url.pathname}`;
    pageContext.origin = url.origin;
  } catch { pageContext.url = null; }
  try { pageContext.title = typeof page.title === 'function' ? (await withTimeout(page.title(), 2000)) : null; } catch {}
  try {
    const text = typeof page.locator === 'function'
      ? await withTimeout(page.locator('body').innerText({ timeout: 2000 }), 2500) : '';
    pageContext.visibleText = summarizeVisibleText(text, safe);
  } catch { pageContext.visibleText = null; }
  try { pageContext.viewport = typeof page.viewportSize === 'function' ? page.viewportSize() : null; } catch {}
  try {
    pageContext.devicePixelRatio = typeof page.evaluate === 'function'
      ? await withTimeout(page.evaluate(() => window.devicePixelRatio), 1500) : null;
  } catch {}
  const document = { ...pageContext, ...(context || {}), schema: 'browser-checkpoint-context/1',
    capturedAt: bundle.capturedAt,
    targetOrigin: origin || null, canonical: name, files: { viewport: name,
      full: bundle.fullName || null, region: bundle.regionName || null } };
  try {
    const contextPath = resolve(directory, `${base}-context.json`);
    await writeFile(contextPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    bundle.contextPath = contextPath; bundle.context = document;
  } catch { bundle.diagnostics.push('context_write_failed'); }
  return bundle;
}

export function summarizeVisibleText(text, safe = value => String(value ?? '')) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  return collapsed ? safe(collapsed.slice(0, 600)) : null;
}

// A focused challenge frame when one is detectable. Candidate order: a real
// challenge iframe first, then a dialog, then the visible form that contains the
// challenge input. The clip is clamped to the viewport and must be large enough
// to be readable; otherwise no region is produced.
export const challengeRegionSelectors = [
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"]',
  '[role="dialog"]',
  'form:has(input[name*="challenge" i]), form:has(input[autocomplete="one-time-code"])',
];

export async function detectChallengeRegion(page, { minWidth = 160, minHeight = 80 } = {}) {
  if (typeof page.locator !== 'function') return null;
  for (const selector of challengeRegionSelectors) {
    let box = null;
    try {
      const locator = page.locator(selector).first();
      if (!await locator.count().catch(() => 0)) continue;
      if (!await locator.isVisible().catch(() => false)) continue;
      box = await withTimeout(locator.boundingBox(), 2000);
    } catch { continue; }
    if (!box || box.width < minWidth || box.height < minHeight) continue;
    let clip = { x: Math.max(0, Math.round(box.x)), y: Math.max(0, Math.round(box.y)),
      width: Math.round(box.width), height: Math.round(box.height) };
    const viewport = typeof page.viewportSize === 'function' ? page.viewportSize() : null;
    if (viewport) {
      clip = { x: Math.min(clip.x, viewport.width - 1), y: Math.min(clip.y, viewport.height - 1),
        width: Math.min(clip.width, viewport.width - Math.min(clip.x, viewport.width - 1)),
        height: Math.min(clip.height, viewport.height - Math.min(clip.y, viewport.height - 1)) };
    }
    if (clip.width < minWidth || clip.height < minHeight) continue;
    return { selector, clip, box };
  }
  return null;
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

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(undefined), ms))]);
}
