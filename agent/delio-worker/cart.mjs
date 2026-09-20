import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { structured, pngBytes } from './vendor/mcp.mjs';
import { WorkerError, SESSION_ID, INITIAL_URL } from './policy.mjs';
import { cartLines, cartLinesSnapshot, summaryRows, couponObservation, productPaths, plnMinor, text } from './cart-reader.mjs';

const ENTRY = /^Twój koszyk, (\d{1,3}) produkt/;
const MAX_ADJUSTMENTS = 40;

// Buttons extracted from an HTML slice become Jev candidates only when they
// carry a clickable attribute (aria-label or testid) — the chooser never
// fabricates a selector. Disabled controls and dangerous labels are excluded
// by the caller's filter.
function buttonCandidates(html, { where, exclude = [], limit = 24 } = {}) {
  const out = [];
  for (const m of html.matchAll(/<button\b([^>]*)>([\s\S]{0,2500}?)<\/button>/g)) {
    const attrs = m[1];
    const ariaRaw = attrs.match(/aria-label="([^"]{1,160})"/)?.[1] || null;
    const ariaLabel = ariaRaw?.trim() || null;
    const textLabel = text(m[2]).slice(0, 80).trim() || null;
    const label = ariaLabel || textLabel || '';
    const testid = attrs.match(/data-testid="([^"]{1,80})"/)?.[1] || null;
    if (/aria-disabled="true"|(?:^|\s)disabled(?:\s|=|>)/.test(attrs)) continue;
    if (!label && !testid) continue;
    let selector = null;
    // Selector must match what's actually present: the aria-label attribute,
    // else the visible text, else the shared testid (may resolve ambiguously —
    // the click then fails closed rather than hitting the wrong control).
    // The raw attribute is used verbatim — trimming it would break exact
    // matching on labels with meaningful whitespace (e.g. trailing space).
    if (ariaLabel && ariaRaw && !/["\\\]]/.test(ariaRaw)) selector = `button[aria-label="${ariaRaw}"]:visible`;
    else if (textLabel && !/["\\\]]/.test(textLabel)) selector = `button:has-text("${textLabel}"):visible`;
    else if (testid && !/["\\\]]/.test(testid)) selector = `button[data-testid="${testid}"]:visible`;
    if (!selector) continue;
    if (exclude.some(re => re.test(label) || re.test(testid || ''))) continue;
    out.push({ id: `c${out.length}`, what: label ? `button "${label}"` : `button (${testid})`, where, selector });
    if (out.length >= limit) break;
  }
  return out;
}
const DANGER = /zamawiam|zapła|płać|wyloguj|usunięcie konta|usuń konto|subskryb|newsletter/i;

// All Delio cart work goes through the owned session's rendered page. Selectors
// and controls are matched by observed names; any ambiguity stops the operation
// without another click. Nothing here submits an order or payment.
export async function runCartOperation(request, { client, check, remaining, config, root, capture, jev = null }) {
  // 'jev' selection: the model picks the control among code-extracted
  // candidates; every click's effect is still verified deterministically.
  const useJev = request.selection === 'jev';
  if (useJev && !jev) throw new WorkerError('jev_unavailable');
  const call = async (name, args = {}, cap = 6000) => {
    check();
    const r = await client.call(name, { session_id: SESSION_ID, ...args }, { timeoutMs: Math.max(1, Math.min(cap, remaining())) });
    check(); return structured(r);
  };
  const declaredCount = async () => {
    const s = await call('browser_snapshot', { max_elements: 200, interactive_only: true });
    const e = (s.elements || []).find(x => x.role === 'button' && ENTRY.test(String(x.name || '').trim()));
    return e ? Number(e.name.trim().match(ENTRY)[1]) : null;
  };
  const view = async () => {
    const snapshot = await call('browser_snapshot', { max_elements: 1000, interactive_only: true });
    const full = await call('browser_snapshot', { max_elements: 1000, interactive_only: false });
    const raw = await call('browser_get_content', { format: 'html', max_bytes: 524288 });
    const html = typeof raw.content === 'string' ? raw.content : typeof raw.html === 'string' ? raw.html : typeof raw.text === 'string' ? raw.text : '';
    return { snapshot, full, html };
  };
  const guardOrigin = snapshot => {
    let url; try { url = new URL(snapshot.url); } catch { throw new WorkerError('merchant_page_unverified'); }
    if (url.origin !== 'https://delio.com.pl') throw new WorkerError('merchant_origin_mismatch');
    return url;
  };
  const settle = async (ms = 350) => { await new Promise(r => setTimeout(r, ms)); check(); };

  // The cart may be a drawer or a page. A re-click on the header entry can
  // close an already-open drawer, so opens only happen when no cart content
  // signature is present.
  // The cart is a dialog opened from the header button; its open state is the
  // button's own aria-expanded or a real dialog element — never page strings,
  // which also appear inside the site's translation bundle.
  // The drawer's a11y nodes stream at the end of the element list; on dense
  // pages they fall outside the snapshot cap. Reading is anchored on a lean
  // product page (verified ~800 interactive elements) so the tail fits.
  const LEAN_PATH = '/products/A0000953-maslo-polskie-extra';
  async function openCart() {
    let declared, current;
    const diag = { clicks: 0, probes: [], menuOpen: false };
    const esc = async () => { try { await call('browser_press_key', { key: 'Escape', selector: 'body', timeout_ms: Math.max(1, Math.min(2000, remaining())) }); } catch (e) { diag.escErr = String(e).slice(0, 60); } };
    for (let leg = 0; leg < 2; leg++) {
      current = await view();
      guardOrigin(current.snapshot);
      // An open account/overlay menu swallows header clicks — the cart button
      // sits under it. Escape dismisses before touching the cart entry.
      if ((current.snapshot.elements || []).some(e => /Wyloguj się|Twoje dane|Adresy dostawy|Historia zamówień/.test(String(e.name || '')))) {
        diag.menuOpen = true;
        await esc(); await settle(350);
        current = await view();
        guardOrigin(current.snapshot);
      }
      const entries = (current.snapshot.elements || []).filter(e => e.role === 'button' && ENTRY.test(String(e.name || '').trim()));
      if (entries.length !== 1) throw new WorkerError('cart_entry_unverified');
      declared = Number(entries[0].name.trim().match(ENTRY)[1]);
      if (!(await drawerOpen())) { await esc(); await settle(350); }
      for (let click = 0; click < 3 && !(await drawerOpen()); click++) {
        diag.clicks++;
        // Click the deterministic test id — snapshot refs drift to the
        // neighbouring account button once hydration reorders the header.
        for (const sel of ['button[data-testid="cart-button"]:visible', '[data-focus-anchor="cart-button"]:visible', 'header button[data-testid="cart-button"] >> nth=0']) {
          try { await call('browser_click', { selector: sel, timeout_ms: Math.max(1, Math.min(4000, remaining())) }); diag.sel = sel; break; }
          catch (e) { diag.selErr = String(e).slice(0, 60); }
        }
        for (let i = 0; i < 4; i++) {
          await settle(500);
          const d = await drawerHtml();
          diag.probes.push(d.length);
          if (d) break;
        }
        try {
          const b = await call('browser_get_content', { selector: '[data-testid="cart-button"]', format: 'html', max_bytes: 8192 });
          diag.expanded = /aria-expanded="true"/.test(JSON.stringify(b));
        } catch (e) { diag.expanded = `err:${String(e).slice(0, 60)}`; }
        if (diag.expanded === true) break;
      }
      if (await drawerOpen()) {
        current = await view();
        guardOrigin(current.snapshot);
        return { declared, diag, ...current };
      }
      // Drawer a11y nodes can sit outside the snapshot cap on dense pages —
      // retry the whole open on a lean product page before giving up.
      if (leg === 0) {
        await call('browser_navigate', { require_existing: true, url: `https://delio.com.pl${LEAN_PATH}`, wait_until: 'load', timeout_ms: Math.max(1, Math.min(10000, remaining())) });
        await settle(700);
      }
    }
    return { declared, diag, ...current };
  }
  async function drawerOpen() { return (await drawerHtml()).length > 0; }
  // The drawer's own DOM may sit past the serialized-HTML cap; its dialog
  // markup is fetched by selector when reachable for quantity/summary reads.
  let drawerSelector;
  async function drawerHtml() {
    for (const selector of drawerSelector ? [drawerSelector] : ['[role="dialog"]', '[data-radix-dialog-content]', '[data-vaul-drawer]', 'div[data-focus-anchor="cart"]']) {
      try {
        const raw = await call('browser_get_content', { selector, format: 'html', max_bytes: 262144 });
        const html = typeof raw.content === 'string' ? raw.content : typeof raw.html === 'string' ? raw.html : typeof raw.text === 'string' ? raw.text : '';
        if (/Usuń z koszyka|Zmniejsz ilość|Przejdź do zamówienia|Twój koszyk|koszyk pust/i.test(html)) { drawerSelector = selector; return html; }
      } catch {}
    }
    // No dialog found: the drawer may simply be closed — probe again next call.
    return '';
  }
  async function readCartState() {
    const opened = await openCart();
    let parsed, parsed2, drawer, lines, gaps, controls, titles;
    for (let attempt = 0; attempt < 4; attempt++) {
      parsed = cartLinesSnapshot(opened.full?.elements, opened.snapshot?.elements);
      drawer = await drawerHtml();
      parsed2 = drawer ? cartLines(drawer) : { lines: [], titles: {} };
      // Real drawer markup is authoritative when captured; the a11y reading
      // supplies stepper refs and must agree with it.
      const merged = [...(parsed2.lines.length ? parsed2.lines : parsed.lines)];
      gaps = [...parsed.gaps];
      for (const id of [...gaps]) {
        const d = parsed2.lines.find(x => x.productId === id);
        if (d) { if (!merged.some(l => l.productId === id)) merged.push(d); gaps.splice(gaps.indexOf(id), 1); }
      }
      for (const d of parsed2.lines) if (!merged.some(l => l.productId === d.productId)) gaps.push(d.productId);
      for (const l of parsed.lines) if (!merged.some(x => x.productId === l.productId)) merged.push(l);
      lines = merged.map(({ productId, quantity }) => ({ productId, quantity }));
      lines.sort((a, b) => a.productId.localeCompare(b.productId));
      const itemSum = lines.reduce((acc, l) => acc + l.quantity, 0);
      if (itemSum !== opened.declared) gaps.push(`count:${opened.declared}`);
      controls = parsed.controls;
      titles = { ...parsed.titles, ...parsed2.titles };
      if (!gaps.length) break;
      // The dialog mounts before its line list hydrates — refresh the view.
      if (attempt < 3) { await settle(800); const fresh = await view(); guardOrigin(fresh.snapshot); opened.full = fresh.full; opened.snapshot = fresh.snapshot; opened.html = fresh.html; }
    }
    if (gaps.length > 0) {
      const artifacts = await capture('cart', opened);
      throw Object.assign(new WorkerError('cart_line_parse_incomplete'), { partial: { artifacts, declared: opened.declared, gaps, diag: opened.diag } });
    }
    return { declared: opened.declared, lines,
      controls, titles, rows: summaryRows(drawer || opened.html), view: { ...opened, drawer } };
  }
  // Click a line's stepper by its deterministic aria-label inside the dialog —
  // snapshot refs drift across hydration, these do not.
  function lineSelector(kind, title) {
    if (/["\\\]]/.test(title)) throw new WorkerError('cart_stepper_unverified');
    const label = { increase: 'Dodaj do koszyka', decrease: 'Zmniejsz ilość', remove: 'Usuń z koszyka' }[kind];
    return `[role="dialog"] button[aria-label="${label}: ${title}"]:visible`;
  }
  async function leaveCart() {
    // Restore the neutral homepage so later operations start deterministically.
    try { await call('browser_navigate', { require_existing: true, url: INITIAL_URL, wait_until: 'load', timeout_ms: Math.max(1, Math.min(10000, remaining())) }); } catch {}
  }
  // The drawer survives SPA navigation and covers the product page's buy box.
  async function closeDrawer() {
    try { await call('browser_press_key', { key: 'Escape', selector: 'body', timeout_ms: Math.max(1, Math.min(2000, remaining())) }); } catch {}
    await settle(400);
    try {
      const raw = await call('browser_get_content', { selector: '[data-testid="cart-button"]', format: 'html', max_bytes: 8192 });
      if (/aria-expanded="true"/.test(JSON.stringify(raw))) {
        try { await call('browser_click', { selector: '[role="dialog"] button:has-text("Zamknij")', timeout_ms: Math.max(1, Math.min(3000, remaining())) }); await settle(400); } catch {}
      }
    } catch {}
  }
  async function rememberedPaths() {
    try {
      const map = JSON.parse(await readFile(`${root}/product-paths.json`, 'utf8'));
      return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
    } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  }

  if (request.operation === 'observeCart') {
    const started = Date.now();
    const state = await readCartState();
    const artifacts = await capture('cart', state.view);
    await leaveCart();
    return { verified: true, status: 'observed', lines: state.lines, declaredCount: state.declared,
      summaryRowCount: state.rows.length, observedAt: started, evidenceRefs: artifacts.map(a => ({ id: a.id, observedAt: started })),
      artifacts, readOnly: true };
  }

  if (request.operation === 'mutateCart') {
    const desired = [...request.lines].sort((a, b) => a.productId.localeCompare(b.productId));
    const paths = await rememberedPaths();
    let dispatched = false;
    const current = await readCartState();
    const now = new Map(current.lines.map(l => [l.productId, l.quantity]));
    // Plan: adds use the product page's observed add control; quantity changes
    // and removals use in-cart steppers matched to the product's line block.
    const needed = [];
    for (const line of desired) {
      const have = now.get(line.productId) || 0;
      if (have === line.quantity) continue;
      if (have === 0) {
        if (!paths[line.productId]) throw new WorkerError('cart_product_path_unknown');
        needed.push({ type: 'add', productId: line.productId, times: line.quantity });
      } else if (line.quantity === 0) needed.push({ type: 'remove', productId: line.productId, times: 1 });
      else needed.push({ type: 'adjust', productId: line.productId, times: Math.abs(line.quantity - have), direction: line.quantity > have ? 'increase' : 'decrease' });
    }
    for (const [id, qty] of now) if (!desired.some(l => l.productId === id)) needed.push({ type: 'remove', productId: id, times: 1 });
    if (needed.reduce((s, n) => s + n.times, 0) > MAX_ADJUSTMENTS) throw new WorkerError('cart_adjustment_budget_exceeded');
    // The drawer persists across navigation and intercepts clicks on the
    // product page — close it before any product-page add.
    if (needed.some(n => n.type === 'add')) { await closeDrawer(); await call('browser_navigate', { require_existing: true, url: INITIAL_URL, wait_until: 'load', timeout_ms: Math.max(1, Math.min(10000, remaining())) }); }
    try {
    for (const step of needed) {
      check();
      if (step.type === 'add') {
        await call('browser_navigate', { require_existing: true, url: 'https://delio.com.pl' + paths[step.productId], wait_until: 'load', timeout_ms: Math.max(1, Math.min(10000, remaining())) });
        let page = null, title = '';
        for (let t = 0; t < 4 && !title; t++) {
          await settle(600); page = await view(); guardOrigin(page.snapshot);
          if (!new RegExp(`/products/${step.productId}-`).test(page.snapshot.url || '')) throw new WorkerError('cart_product_page_mismatch');
          // The h1 lives in static markup; the a11y heading is the fallback.
          const h1 = (page.html || '').match(/<h1[^>]*>([^<]{1,120})<\/h1>/);
          const heading = (page.full?.elements || page.snapshot.elements || []).find(e => e.role === 'heading' && e.level === 1);
          title = (h1 ? text(h1[1]) : '') || (heading ? String(heading.name || '').split('\n')[0].trim() : '');
        }
        if (!title || /["\\\]]/.test(title)) throw Object.assign(new WorkerError('cart_add_control_unverified'), { blocked: { productId: step.productId, reason: 'add_control_unverified' } });
        // Verify the buy box before any click: a substitutes control means the
        // store has no stock; a missing add label means markup we can't verify.
        // The PDP buy box sits early in the document, inside the capture cap.
        const mainHtml = page.html || '';
        if (/data-testid="see-substitutes-button"/.test(mainHtml)) throw Object.assign(new WorkerError('cart_product_unavailable'), { blocked: { productId: step.productId, reason: 'product_unavailable' } });
        // Delio pads some add labels with trailing whitespace; match the title
        // then capture the attribute verbatim for the click selector.
        const addM = mainHtml.match(new RegExp(`aria-label="(Dodaj do koszyka: ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*)"`));
        if (!useJev && !addM) throw Object.assign(new WorkerError('cart_add_control_unverified'), { blocked: { productId: step.productId, reason: 'add_control_unverified' } });
        // The PDP embeds observed availability for this store — refuse early
        // when the plan exceeds stock instead of clicking into the cap.
        const skuAt = mainHtml.indexOf(`"sku":"${step.productId}"`) >= 0 ? mainHtml.indexOf(`"sku":"${step.productId}"`) : mainHtml.indexOf(`"key":"${step.productId}"`);
        const availM = skuAt >= 0 ? mainHtml.slice(skuAt, skuAt + 40000).match(/"availableQuantity":(\d{1,5})/) : null;
        if (availM && Number(availM[1]) < step.times) throw Object.assign(new WorkerError('cart_stock_insufficient'), { blocked: { productId: step.productId, reason: `stock_insufficient:${availM[1]}` } });
        if (useJev) {
          // Jev chooses the add control among this page's own buttons; the
          // header item-count increment verifies each click's effect.
          const mainAt = mainHtml.search(/<main[\s>]/i);
          const scope = mainHtml.slice(mainAt >= 0 ? mainAt : 0, (mainAt >= 0 ? mainAt : 0) + 80000);
          const candidates = buttonCandidates(scope, { where: `product page for "${title}"`, exclude: [DANGER, /zamiennik|substitut|ulubion|schowka|zamknij/i] });
          const picked = await jev.choose({ intent: `Add the product "${title}" to the shopping cart (one unit per activation). Other products' tiles may appear on this page; only the control for "${title}" qualifies.`, candidates });
          const selector = `main ${picked.selector}`;
          dispatched = true;
          let count = await declaredCount();
          for (let i = 0; i < step.times; i++) {
            try { await call('browser_click', { selector, timeout_ms: Math.max(1, Math.min(4000, remaining())) }); }
            catch (error) {
              error.blocked ??= { productId: step.productId, reason: 'add_click_failed' };
              try { const v = await view(); error.partial = { artifacts: await capture('cart', v), diag: { selector, jev: picked.what } }; } catch {}
              throw error;
            }
            if (count === null) { await settle(600); continue; }
            let landed = false;
            for (let w = 0; w < 8; w++) { await settle(500); const c = await declaredCount(); if (c === count + 1) { count = c; landed = true; break; } }
            if (!landed) throw Object.assign(new WorkerError('cart_add_unverified'), { blocked: { productId: step.productId, reason: 'add_effect_unverified' } });
          }
        } else {
        dispatched = true;
        for (let i = 0; i < step.times; i++) {
          // The PDP buy-box control is labelled with the product title; tiles
          // on the same page recommend other products, never this one. The
          // label is the verbatim attribute captured above.
          try { await call('browser_click', { selector: `button[aria-label="${addM[1]}"]:visible`, timeout_ms: Math.max(1, Math.min(4000, remaining())) }); }
          catch (error) { error.blocked ??= { productId: step.productId, reason: 'add_click_failed' }; throw error; }
          await settle(600);
        }
        }
      } else {
        // Quantity edits happen inside the open cart against the exact line.
        const state = await readCartState();
        const target = state.lines.find(l => l.productId === step.productId);
        if (!target) throw Object.assign(new WorkerError('cart_line_missing'), { blocked: { productId: step.productId, reason: 'line_missing' } });
        const title = state.titles?.[step.productId];
        if (!title) throw Object.assign(new WorkerError('cart_stepper_unverified'), { blocked: { productId: step.productId, reason: 'stepper_unverified' } });
        const kind = step.type === 'remove' ? 'remove' : step.direction === 'decrease' ? 'decrease' : 'increase';
        let sel = lineSelector(kind, title), jevPicked = null;
        if (useJev) {
          // Jev picks among the buttons actually inside this product's cart
          // line — the same block the deterministic path slices.
          const block0 = await drawerHtml().then(d => { const at = d.indexOf(`/products/${step.productId}-`); return at < 0 ? '' : d.slice(at, at + 14000); });
          const intents = { increase: `Increase the quantity of "${title}" in the cart by one unit`, decrease: `Decrease the quantity of "${title}" in the cart by one unit`, remove: `Remove "${title}" from the cart entirely` };
          const other = { increase: /usuń|usun|remove|zmniejsz|decrease|zamknij|zamówienia|przejdź/i, decrease: /usuń|usun|remove|dodaj|increase|zamknij|zamówienia|przejdź/i, remove: /dodaj|increase|zmniejsz|decrease|zamknij|zamówienia|przejdź/i }[kind];
          try { jevPicked = await jev.choose({ intent: intents[kind], candidates: buttonCandidates(block0, { where: `cart line for "${title}"`, exclude: [DANGER, other] }) }); }
          catch (error) { error.blocked ??= { productId: step.productId, reason: 'stepper_unverified' }; throw error; }
          sel = `[role="dialog"] ${jevPicked.selector}`;
        }
        const readQty = async () => {
          const d = await drawerHtml();
          const at = d.indexOf(`/products/${step.productId}-`);
          const m = at < 0 ? null : d.slice(at, at + 14000).match(/CartCounter__quantity-in-active-cart"[^>]*>\s*(\d{1,3})\s*</);
          return m ? Number(m[1]) : null;
        };
        const lineBlock = async () => {
          const d = await drawerHtml();
          const at = d.indexOf(`/products/${step.productId}-`);
          return at < 0 ? '' : d.slice(at, at + 14000);
        };
        let expect = target.quantity;
        for (let i = 0; i < step.times; i++) {
          expect = kind === 'increase' ? expect + 1 : kind === 'decrease' ? expect - 1 : 0;
          // The drawer can close between observation and click (SPA events,
          // focus loss) — confirm it is open immediately before dispatching.
          if (!(await drawerOpen())) await openCart();
          // A capped line renders its control aria-disabled before the click —
          // a timeout there is a merchant limit, not an uncertain dispatch.
          const block = await lineBlock();
          // Cap pre-check: match the control we're about to click — the Jev
          // path checks its own picked label since wording may differ.
          const capLabel = jevPicked ? jevPicked.what.match(/^button "([^"]+)"$/)?.[1] : ({ remove: 'Usuń z koszyka', decrease: 'Zmniejsz ilość', increase: 'Dodaj do koszyka' }[kind] + ': ' + title);
          const btn = capLabel && !/["\\\]]/.test(capLabel) ? block.match(new RegExp(`<button[^>]*aria-label="${capLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*"[^>]*>`)) : null;
          // Tailwind emits "-disabled" class suffixes — "disabled" is only real
          // when not preceded by - or a word char and not followed by ':'.
          if (btn && /aria-disabled="true"|(?<![-\w:])disabled(?=[\s=>])/.test(btn[0])) throw Object.assign(new WorkerError('cart_quantity_capped'), { blocked: { productId: step.productId, reason: 'quantity_capped' } });
          dispatched = true;
          try { await call('browser_click', { selector: sel, timeout_ms: Math.max(1, Math.min(4000, remaining())) }); }
          catch (error) {
            error.blocked ??= { productId: step.productId, reason: 'stepper_click_failed' };
            try { const v = await view(); v.drawer = await drawerHtml(); error.partial = { artifacts: await capture('cart', v), diag: { selector: sel } }; } catch {}
            throw error;
          }
          // The stepper goes aria-disabled while the merchant applies the
          // change — wait for the counter to reflect it before clicking again.
          let q = null;
          for (let w = 0; w < 8; w++) {
            await settle(500);
            q = kind === 'remove' ? ((await drawerHtml()).includes(`Usuń z koszyka: ${title}`) ? -1 : 0) : await readQty();
            if (q === expect) break;
          }
          // A click that moves nothing (merchant cap, stale control) must stop
          // here tagged to this line — silently continuing reports the item as
          // "did not land" with no reason.
          if (q !== expect) throw Object.assign(new WorkerError('cart_adjust_unverified'), { blocked: { productId: step.productId, reason: kind === 'increase' ? 'quantity_capped' : 'adjust_effect_unverified' } });
        }
      }
    }
    const after = await readCartState();
    const artifacts = await capture('cart', after.view);
    await leaveCart();
    const observedAt = Date.now();
    const matched = JSON.stringify(after.lines) === JSON.stringify(desired.map(({ productId, quantity }) => ({ productId, quantity })));
    return { verified: true, status: 'observed', lines: after.lines, dispatched, matchedDesired: matched,
      declaredCount: after.declared, observedAt, evidenceRefs: artifacts.map(a => ({ id: a.id, observedAt })), artifacts,
      usage: jev?.usage?.() ?? { modelCalls: 0, modelCostUsd: 0 }, jevChoices: jev?.choices ?? [] };
    } catch (error) {
      if (dispatched) error.cartDispatched = true;
      if (jev) { error.usage = jev.usage(); error.jevChoices = jev.choices; }
      // Leave the browser on a neutral page: a failure mid-PDP or with a
      // dialog open otherwise makes the next read burn its budget retrying.
      try { await call('browser_press_key', { key: 'Escape', selector: 'body', timeout_ms: 2000 }, 3000); } catch {}
      try { await call('browser_navigate', { require_existing: true, url: INITIAL_URL, wait_until: 'load', timeout_ms: 8000 }, 9000); } catch {}
      throw error;
    }
  }

  if (request.operation === 'quote') {
    const observedAt = Date.now();
    const artifacts = [];
    // /cart -> /checkout, both direct navigation + one verified click each.
    // Order/payment submit controls are never clicked; the quote is read-only.
    await call('browser_navigate', { url: 'https://delio.com.pl/cart', wait_until: 'load', timeout_ms: Math.max(1, Math.min(15000, remaining())) });
    await settle(1200);
    const cartPage = await view();
    guardOrigin(cartPage.snapshot);
    if (!/^\/cart\/?$/.test(new URL(cartPage.snapshot.url).pathname)) throw new WorkerError('cart_page_unverified');
    artifacts.push(...await capture('quote-cart', cartPage));
    const cartEmbedded = embeddedCart(cartPage.html);
    if (!cartEmbedded?.lines?.length) { throw new WorkerError('quote_empty_cart'); }
    const ck = await call('browser_click', { selector: 'main button:has-text("Przejdź do zamówienia")', timeout_ms: Math.max(1, Math.min(6000, remaining())) }).then(() => true).catch(() => false);
    if (!ck) throw new WorkerError('checkout_entry_unverified');
    let checkout = null;
    for (let i = 0; i < 6; i++) {
      await settle(800); checkout = await view(); guardOrigin(checkout.snapshot);
      try { if (/^\/checkout\/?$/.test(new URL(checkout.snapshot.url).pathname)) break; } catch {}
      checkout = null;
    }
    if (!checkout) throw new WorkerError('checkout_entry_unverified');
    artifacts.push(...await capture('quote-checkout', checkout));
    const embedded = embeddedCart(checkout.html);
    const grid = summaryGrid(checkout.html);
    const total = gridTotals(grid);
    const coupon = couponObservation(checkout.html, config.expectedCouponCode);
    await leaveCart();
    const problems = [];
    if (!embedded) problems.push('embedded_cart_unparsed');
    if (!total.complete) problems.push(`summary_missing:${total.missing.join('|')}`);
    if (embedded) {
      const pair = a => JSON.stringify(a.map(({ productId, quantity }) => ({ productId, quantity })));
      if (pair(embedded.lines) !== pair(cartEmbedded.lines)) problems.push('checkout_cart_mismatch');
      if (embedded.address) {
        const a = embedded.address;
        for (const [key, expected] of [['streetName', config.expectedStreet], ['streetNumber', config.expectedBuilding],
          ['city', config.expectedCity], ['postalCode', config.expectedPostalCode]]) {
          if (expected && String(a[key] || '') !== String(expected)) problems.push(`address_mismatch:${key}`);
        }
      } else problems.push('address_unobserved');
      if (!embedded.fulfillmentAreaId) problems.push('fulfillment_area_unobserved');
      else if (config.fulfillmentAreaId && embedded.fulfillmentAreaId !== config.fulfillmentAreaId) problems.push('fulfillment_area_mismatch');
      if (total.complete && embedded.totalPriceMinor !== null && embedded.totalPriceMinor !== total.amounts.merchantTotalMinor)
        problems.push('checkout_total_mismatch');
    }
    if (problems.length) return { verified: false, status: 'quote_incomplete', problems, lines: cartEmbedded.lines,
      rows: grid, coupon, observedAt, evidenceRefs: artifacts.map(a => ({ id: a.id, observedAt })), artifacts };
    const stockObservedAt = Date.now();
    return { verified: true, status: 'observed', lines: embedded.lines.map(l => ({ productId: l.productId,
      quantity: l.quantity, unitPriceMinor: l.unitPriceMinor, lineTotalMinor: l.lineTotalMinor })), rows: grid,
      amounts: total.amounts, currency: 'PLN', observedAt, expiresAt: observedAt + 120000,
      deliveryCommitment: config.deliveryCommitment || null, regionId: config.regionId || null,
      fulfillmentAreaId: embedded.fulfillmentAreaId,
      deliverySlot: embedded.deliverySlot || null,
      couponResults: embedded.couponResults(config.expectedCouponCode)
        // Delio reports an applied coupon as a "Rabat" summary row; the
        // embedded discountCodes array stays empty for this coupon type.
        .map(c => c.accepted ? { ...c, discountMinor: total.amounts.discountMinor }
          : total.amounts.discountMinor > 0 ? { code: c.code, accepted: true, discountMinor: total.amounts.discountMinor, reason: 'discount row observed in order summary' } : c),
      stockProof: { customerId: config.customerId || 'pilot-owner', merchantAccountId: config.merchantAccountId || 'delio-pilot-owner',
        deliveryCommitment: config.deliveryCommitment || null, regionId: config.regionId || null,
        fulfillmentAreaId: embedded.fulfillmentAreaId, observedAt: stockObservedAt,
        lines: embedded.lines.map(l => ({ productId: l.productId, quantity: l.quantity, availableQuantity: l.availableQuantity })) },
      evidenceRefs: artifacts.map(a => ({ id: a.id, observedAt })), artifacts };
  }
  if (request.operation === 'applyCoupon') {
    const code = config.expectedCouponCode;
    if (!code) throw new WorkerError('coupon_unconfigured');
    if (!jev) throw new WorkerError('jev_unavailable');
    const observedAt = Date.now();
    const artifacts = [];
    let dispatched = false;
    try {
      // The coupon entry point and the embedded discountCodes state both live
      // on /cart — the whole flow runs there; the later quote re-verifies on
      // /checkout anyway.
      await call('browser_navigate', { url: 'https://delio.com.pl/cart', wait_until: 'load', timeout_ms: Math.max(1, Math.min(15000, remaining())) });
      await settle(1500);
      const cartPage = await view();
      guardOrigin(cartPage.snapshot);
      if (!/^\/cart\/?$/.test(new URL(cartPage.snapshot.url).pathname)) throw new WorkerError('cart_page_unverified');
      artifacts.push(...await capture('coupon-cart', cartPage));
      // Already applied? Verify and exit without dispatching anything.
      const before = embeddedCart(cartPage.html);
      const appliedBefore = (before?.discountCodes || []).map(c => String(c?.code ?? c)).includes(code)
        || gridTotals(summaryGrid(cartPage.html)).amounts.discountMinor > 0;
      if (appliedBefore) {
        return { verified: true, status: 'observed', coupon: { code, accepted: true, alreadyApplied: true },
          dispatched, observedAt, evidenceRefs: artifacts.map(a => ({ id: a.id, observedAt })), artifacts,
          usage: jev.usage?.() ?? { modelCalls: 0, modelCostUsd: 0 }, jevChoices: jev.choices ?? [] };
      }
      // Open the coupon entry point — a single real button carries the label.
      let opened = false, clickErr = '';
      for (const sel of ['button:has-text("Dodaj kod rabatowy"):visible', 'button:has-text("aktywuj kupon"):visible', 'button:has-text("Dodaj kod rabatowy") >> nth=0']) {
        try { await call('browser_click', { selector: sel, timeout_ms: Math.max(1, Math.min(6000, remaining())) }); opened = true; break; }
        catch (e) { clickErr = String(e?.browserFailure?.reason || e?.code || e).slice(0, 80); }
      }
      if (!opened) throw Object.assign(new WorkerError('coupon_entry_unverified'), { blocked: { reason: 'coupon_entry_unverified', detail: `click_failed:${clickErr}` } });
      // The entry click only opens a dialog — not a cart mutation. dispatched
      // flips true just before the first apply/confirm dispatch.
      await settle(1000);
      // The dialog's own markup is the candidate scope — unrelated page
      // controls never enter the choice set.
      const dialogHtml = async () => {
        for (const sel of ['[role="dialog"]', '[data-radix-dialog-content]', '[data-radix-popper-content-wrapper]']) {
          try {
            const raw = await call('browser_get_content', { selector: sel, format: 'html', max_bytes: 131072 });
            const h = typeof raw.content === 'string' ? raw.content : typeof raw.html === 'string' ? raw.html : '';
            if (/kod rabatowy|kupon|rabat/i.test(h)) return { h, sel };
          } catch {}
        }
        return null;
      };
      const couponExcludes = [/zamknij|close|anuluj|cancel|wróć|back|×/i, /zamów|zapła|płać|pay|order|submit|kupuj|checkout|przejdź/i, /wyloguj|log ?out|usuń konto|newsletter|subskryb/i];
      let obs = await view();
      guardOrigin(obs.snapshot);
      let dlg = await dialogHtml();
      // Path A: the dialog lists an activate control for the coupon — Jev
      // picks it among observed candidates. No typing needed.
      let picked = null;
      if (dlg) {
        // Several coupons can share one "Wybierz kupon" label — scope the
        // choice to the card that actually displays the -75 zl offer.
        const cardAt = dlg.h.search(/-?75[,.]?0?0?\s*zł|Witaj w delio/i);
        const scope = cardAt >= 0 ? dlg.h.slice(cardAt, cardAt + 14000) : dlg.h;
        const cands = buttonCandidates(scope, { where: 'coupon card (-75 zl)', limit: 20, exclude: couponExcludes });
        // 'none'/low-confidence throws; that just means path B (typing the
        // code) should run.
        if (cands.length) try {
          picked = await jev.choose({
            intent: 'Activate the displayed first-order discount coupon (the -75 zl "Witaj w delio" offer) for this order — choose its select/activate control',
            candidates: cands });
        } catch (e) { if (e.code !== 'jev_control_unverified') throw e; }
        if (picked?.selector) {
          dispatched = true;
          // The same label can appear on several coupon cards; the target
          // card's control is the first occurrence after the price text.
          let sel = `${dlg.sel} ${picked.selector}`;
          const lm = picked.selector.match(/has-text\("([^"]+)"\)/);
          if (lm && cardAt >= 0) {
            const nth = dlg.h.slice(0, cardAt).split(lm[1]).length - 1;
            sel = `${dlg.sel} button:has-text("${lm[1]}") >> nth=${nth}`;
          }
          await call('browser_click', { selector: sel, timeout_ms: Math.max(1, Math.min(4000, remaining())) });
          await settle(1500);
          // Verify the pick actually applied before skipping path B — Delio
          // reports the applied coupon as a Rabat row, not in discountCodes.
          const mid = await view(); guardOrigin(mid.snapshot);
          if ((embeddedCart(mid.html)?.discountCodes || []).map(c => String(c?.code ?? c)).includes(code)
            || gridTotals(summaryGrid(mid.html)).amounts.discountMinor > 0) picked.applied = true;
        }
      }
      // Path B: no activate control (or its click did not apply) — type the
      // code into the dialog's field, then Jev picks the submit control.
      if (!picked?.applied) {
        obs = await view(); guardOrigin(obs.snapshot); dlg = await dialogHtml();
        if (dlg && /<input\b/i.test(dlg.h)) {
          await call('browser_type', { selector: `${dlg.sel} input:visible`, text: code, clear_first: true, press_enter_after: false, timeout_ms: Math.max(1, Math.min(4000, remaining())) });
          await settle(600);
          dlg = await dialogHtml();
          if (dlg) {
            const cands = buttonCandidates(dlg.h, { where: 'coupon dialog', limit: 20, exclude: couponExcludes });
            if (cands.length) try {
              const pick = await jev.choose({
                intent: `Submit the typed discount code "${code}" — choose the dialog's save/apply control ("Zapisz")`,
                candidates: cands });
              if (pick?.selector) {
                dispatched = true;
                await call('browser_click', { selector: `${dlg.sel} ${pick.selector}`, timeout_ms: Math.max(1, Math.min(4000, remaining())) });
              }
            } catch (e) { if (e.code !== 'jev_control_unverified') throw e; }
          }
          await settle(1200);
        } else if (!picked?.selector) throw Object.assign(new WorkerError('coupon_candidates_unobserved'), { blocked: { reason: 'coupon_candidates_unobserved' } });
      }
      await settle(1500);
      const after = await view();
      guardOrigin(after.snapshot);
      artifacts.push(...await capture('coupon-applied', after));
      const embedded = embeddedCart(after.html);
      const grid = gridTotals(summaryGrid(after.html));
      const applied = (embedded?.discountCodes || []).map(c => String(c?.code ?? c)).includes(code) || grid.amounts.discountMinor > 0;
      if (!applied) throw Object.assign(new WorkerError('coupon_not_applied'), { blocked: { reason: 'coupon_not_applied' } });
      return { verified: true, status: 'observed', coupon: { code, accepted: true, alreadyApplied: false },
        dispatched, observedAt, evidenceRefs: artifacts.map(a => ({ id: a.id, observedAt })), artifacts,
        usage: jev.usage?.() ?? { modelCalls: 0, modelCostUsd: 0 }, jevChoices: jev.choices ?? [] };
    } catch (error) {
      if (dispatched) error.cartDispatched = true;
      error.usage = jev.usage?.(); error.jevChoices = jev.choices;
      try { const v = await view(); error.partial = { artifacts: await capture('coupon-fail', v) }; } catch {}
      throw error;
    }
  }
  throw new WorkerError('invalid_request');
}

// Extract a JSON value embedded in the page's serialized data by key, using
// bracket matching. Returns undefined when the key is absent or unparseable.
function embeddedJson(html, key, from = 0) {
  const marker = `"${key}":`;
  const at = html.indexOf(marker, from);
  if (at < 0) return undefined;
  let i = at + marker.length;
  while (/\s/.test(html[i])) i++;
  const open = html[i];
  const pairs = { '{': '}', '[': ']', '"': '"' };
  if (!pairs[open]) {
    const m = html.slice(i).match(/^(?:-?\d+(?:\.\d+)?|true|false|null)/);
    if (!m) return undefined;
    try { return JSON.parse(m[0]); } catch { return undefined; }
  }
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < html.length; j++) {
    const c = html[j];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === pairs[open] && --depth === 0) {
      try { return JSON.parse(html.slice(i, j + 1)); } catch { return undefined; }
    }
  }
  return undefined;
}

// Parse the serialized cart payload on /checkout: priced lines with observed
// availability, totals, applied discount codes, shipping address, darkstore.
function embeddedCart(html) {
  const items = embeddedJson(html, 'lineItems');
  if (!Array.isArray(items) || !items.length) return null;
  const lines = [];
  for (const item of items) {
    const p = item?.product;
    const sku = p?.sku || p?.key;
    const qty = item?.quantity;
    const unit = p?.price?.discounted?.value?.centAmount ?? p?.price?.value?.centAmount;
    const available = p?.availableQuantity;
    if (!/^A\d{7}$/.test(sku || '') || !Number.isSafeInteger(qty) || qty < 1
        || !Number.isSafeInteger(unit) || !Number.isSafeInteger(available)) return null;
    lines.push({ productId: sku, quantity: qty, unitPriceMinor: unit, lineTotalMinor: unit * qty, availableQuantity: available });
  }
  lines.sort((a, b) => a.productId.localeCompare(b.productId));
  const address = embeddedJson(html, 'defaultShippingAddress');
  const brands = embeddedJson(html, 'brandsDashboard');
  const fulfillmentAreaId = brands?.brands?.[0]?.darkstore?.key || null;
  const codes = embeddedJson(html, 'discountCodes') ?? [];
  const totalCent = embeddedJson(html, 'totalPrice')?.centAmount;
  const slotM = html.match(/Dostawa jak najszybciej<\/[^>]+>\s*<[^>]+>([^<]{3,60})</)
    || html.match(/Jutro[^<]{0,40}\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/);
  const deliverySlot = slotM ? text(slotM[1] ?? slotM[0]) : null;
  return { lines, address, fulfillmentAreaId, discountCodes: Array.isArray(codes) ? codes : [],
    totalPriceMinor: Number.isSafeInteger(totalCent) ? totalCent : null, deliverySlot,
    couponResults(expected) {
      const applied = this.discountCodes.map(c => String(c?.code ?? c));
      const matched = expected && applied.includes(expected);
      return expected ? [{ code: expected, accepted: matched, discountMinor: 0,
        ...(matched ? {} : { reason: 'not applied at observation time' }) }] : [];
    } };
}

// Parse the "Podsumowanie rachunku" grid: label/value div pairs.
function summaryGrid(html) {
  const marker = html.indexOf('Podsumowanie rachunku');
  if (marker < 0) return [];
  const gridStart = html.indexOf('grid-cols-[1fr_auto]', marker);
  if (gridStart < 0) return [];
  const seg = html.slice(gridStart, gridStart + 12000);
  // Grid cells are divs, but some rows (e.g. the weight deposit) use buttons.
  const cells = [...seg.matchAll(/<(?:div|button)[^>]*>([\s\S]{0,2500}?)<\/(?:div|button)>/g)].map(m => text(m[1])).filter(Boolean);
  const rows = [];
  for (let i = 0; i + 1 < cells.length; i += 2) {
    const amount = plnMinor(cells[i + 1]);
    if (amount === null) continue;
    rows.push({ label: cells[i], amountMinor: amount });
    if (/^Razem$/i.test(cells[i])) break;
  }
  return rows;
}

// Map a product's cart line to its +/- stepper refs from the snapshot+html.
// Returns nulls when the mapping is not unambiguous.
function lineSteppers(view, productId) {
  const clean = view.html;
  const anchor = clean.indexOf(`/products/${productId}-`);
  if (anchor < 0) return { increase: null, decrease: null };
  const block = clean.slice(anchor, anchor + 12000);
  const plus = block.match(/data-testid="([^"]*(?:increase|plus|add)[^"]*)"/i);
  const minus = block.match(/data-testid="([^"]*(?:decrease|minus|remove)[^"]*)"/i);
  return { increase: null, decrease: null, hints: { plus: plus?.[1] || null, minus: minus?.[1] || null } };
}

// Turn summary-grid rows into the fixed quote amounts shape. Unrecognised
// rows accumulate into otherFeesMinor so the arithmetic stays honest; the two
// anchors (item subtotal, grand total) must be present to call it complete.
function gridTotals(rows) {
  let itemSubtotalMinor = null, deliveryFeeMinor = null, serviceFeeMinor = 0,
    smallOrderFeeMinor = 0, otherFeesMinor = 0, depositsMinor = 0, discountMinor = 0, merchantTotalMinor = null;
  for (const row of rows) {
    const l = row.label;
    if (/^Wartość produktów$/i.test(l)) itemSubtotalMinor = row.amountMinor;
    else if (/^Razem$/i.test(l) || /do zapłaty/i.test(l)) merchantTotalMinor = row.amountMinor;
    else if (/rabat|zniżk|kupon|promocj|discount/i.test(l)) discountMinor += Math.abs(row.amountMinor);
    else if (/dostaw|delivery/i.test(l)) deliveryFeeMinor = (deliveryFeeMinor ?? 0) + row.amountMinor;
    else if (/pakowani|serwis|obsług|service/i.test(l)) serviceFeeMinor += row.amountMinor;
    else if (/małego zamówienia|small order/i.test(l)) smallOrderFeeMinor += row.amountMinor;
    else if (/kaucj|depozyt|zwrotn/i.test(l)) depositsMinor += row.amountMinor;
    else otherFeesMinor += row.amountMinor;
  }
  const amounts = { itemSubtotalMinor, deliveryFeeMinor, serviceFeeMinor, smallOrderFeeMinor, otherFeesMinor, depositsMinor, discountMinor, merchantTotalMinor };
  const missing = Object.entries(amounts).filter(([, v]) => v === null).map(([k]) => k);
  if (missing.length === 0) {
    const beforeDiscount = amounts.itemSubtotalMinor + deliveryFeeMinor + serviceFeeMinor + smallOrderFeeMinor + otherFeesMinor + depositsMinor;
    if (beforeDiscount - discountMinor !== merchantTotalMinor) missing.push('total_arithmetic');
  }
  return { amounts, missing, complete: missing.length === 0 };
}

export async function persistProductPaths(root, items) {
  let map = {};
  try { map = JSON.parse(await readFile(`${root}/product-paths.json`, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let changed = false;
  for (const p of items || []) {
    try {
      const path = new URL(p.sourceUrl).pathname;
      if (/^\/products\/A\d{7}-[^/?#]+$/.test(path) && map[p.productId] !== path) { map[p.productId] = path; changed = true; }
    } catch {}
  }
  if (!changed) return;
  const entries = Object.entries(map).slice(0, 500);
  await writeFile(`${root}/product-paths.json.tmp`, JSON.stringify(Object.fromEntries(entries), null, 2), { mode: 0o600 });
  const { rename } = await import('node:fs/promises');
  await rename(`${root}/product-paths.json.tmp`, `${root}/product-paths.json`);
}
