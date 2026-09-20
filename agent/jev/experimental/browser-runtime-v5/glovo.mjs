// Glovo Kraków site adapter for the v5 stepwise runtime. Read-only navigation:
// find the merchant store, open the product, verify identity + both product
// ids + visible title. No basket, order, payment, account or file action is
// ever offered or permitted — the Polish basket terms are denied before the
// model sees candidates and the request guard blocks mutation traffic.
import { navigationUrl, blocksNavigationMutation, verifyNavigation, readNavigationDom } from '../../src/navigation.mjs';
import { normalize, assert } from '../../src/config.mjs';

// The shared navigationUrl grammar predates Glovo's in-store `section` /
// `sectionId` scroll params — a same-store link carrying only those extras
// is still a read-only store navigation. Accept a URL when it is already
// permitted, or becomes permitted by stripping section-family params.
export function glovoNavigationUrl(value) {
  if (navigationUrl(value)) return true;
  try {
    const u = new URL(value);
    let stripped = false;
    for (const key of [...u.searchParams.keys()]) {
      if (/^section(Id)?$/i.test(key)) { u.searchParams.delete(key); stripped = true; }
    }
    // Any remaining params are judged by the shared grammar itself.
    return stripped && navigationUrl(u.href);
  } catch { return false; }
}

// Identical verdicts to the proven v3 route guard: abort mutation-class
// traffic (the product-view POST read is exempted inside
// blocksNavigationMutation) and out-of-scope navigations; everything else —
// including ordinary analytics POSTs — continues. v5 adds severity: an
// out-of-scope MAIN-FRAME navigation is fatal; a blocked mutation or a
// sub-frame navigation (tracker iframes) is quietly aborted and counted,
// exactly as the v3 guard's route.abort() behaved.
export function glovoRequestFilter(task, counters = {}) {
  const deny = (request, why, fatal = false) => {
    if (why === 'mutation') counters.blockedMutations = (counters.blockedMutations || 0) + 1;
    (counters.denied ||= []).push({ method: request.method(), url: request.url().slice(0, 300),
      navigation: request.isNavigationRequest(), why });
    return fatal ? 'fatal' : 'deny';
  };
  return (request, { mainFrame = true } = {}) => {
    const method = request.method(), url = request.url();
    if (blocksNavigationMutation(method, url, { task, postData: request.postData() })) return deny(request, 'mutation');
    if (request.isNavigationRequest() && !glovoNavigationUrl(url)) return deny(request, 'navigation_scope', mainFrame);
    return 'allow';
  };
}

// Deterministic handlers for the two known Glovo interstitials. The age
// confirmation is included only when the caller explicitly authorizes it
// and only for the one approved case — the same boundary as v3's
// repeatAuthorizedAgeConfirmation (task id + target store path). Without
// it, the dialog's controls are policy-excluded so the model can never
// consent on its own.
export function glovoHandlers(task, { authorizeAgeConfirmation = false } = {}) {
  const handlers = [
    { name: 'browser_challenge_guard',
      when: data => /verify you are human|captcha challenge|potwierdź, że jesteś człowiekiem/i.test(data.text || ''),
      act: () => { throw Object.assign(new Error('browser_challenge'), { code: 'browser_challenge' }); } },
    { name: 'site_unavailable_guard',
      when: data => /Oh, no![\s\S]*It looks like there's a problem, but we're working on it\./i.test(data.text || ''),
      act: () => { throw Object.assign(new Error('merchant_site_unavailable'), { code: 'merchant_site_unavailable' }); } },
    { name: 'closed_store_notice',
      when: data => data.dialogOpen,
      act: async ({ page }) => {
        const dialog = page.locator('[role="dialog"],dialog').last();
        if (!/teraz nie pracuje\. Następne otwarcie:|Punkt .+ jest tymczasowo zamknięty/i
          .test(await dialog.innerText().catch(() => ''))) return false;
        const close = dialog.getByRole('button', { name: 'Zamknij', exact: true });
        if (!await close.count()) return false;
        try { await close.click({ timeout: 5000 }); } catch { return 'retry'; }
        return true;
      } }];
  if (authorizeAgeConfirmation) {
    assert(task.id === 'krakow-home-to-foczka-bacardi', 'age_confirmation_not_authorized_for_case');
    handlers.push({
      name: 'repeat_scoped_age_confirmation',
      when: data => data.dialogOpen,
      act: async ({ page }) => {
        const dialog = page.getByRole('dialog', { name: 'Potwierdź pełnoletniość', exact: true });
        // Not the age dialog at all (e.g. the product modal) → pass instantly.
        // Present-but-animating returns 'retry' — the next step re-observes;
        // wrong terms or missing controls are hard failures, never retried.
        if (!await dialog.count()) return false;
        try { await dialog.waitFor({ state: 'visible', timeout: 3000 }); } catch { return 'retry'; }
        const target = new URL(task.targetUrl), current = new URL(page.url());
        assert(current.origin === target.origin && current.pathname === target.pathname, 'age_confirmation_wrong_store');
        assert(await dialog.count() === 1, 'age_confirmation_dialog_not_found');
        const text = await dialog.innerText().catch(() => '');
        if (!text) return 'retry';
        assert(/Potwierdzam, że mam co najmniej 18 lat i akceptuję regulamin sprzedaży napojów alkoholowych\./.test(text),
          'unexpected_age_confirmation_terms');
        const checkbox = dialog.getByRole('checkbox');
        assert(await checkbox.count() === 1, 'unexpected_age_confirmation_controls');
        try {
          await checkbox.check({ timeout: 5000 });
          await dialog.getByRole('button', { name: 'Zaakceptuj', exact: true }).click({ timeout: 5000 });
          await dialog.waitFor({ state: 'hidden', timeout: 10000 });
        } catch { return 'retry'; }
        return true;
      } });
  } else {
    // Without explicit authorization the age dialog ends the run with the
    // same reason the v3 route raises — never a model decision.
    handlers.push({
      name: 'age_confirmation_gate',
      when: data => data.dialogOpen,
      act: async ({ page }) => {
        if (!await page.getByRole('dialog', { name: 'Potwierdź pełnoletniość', exact: true }).count()) return false;
        throw Object.assign(new Error('age_confirmation_requires_user'), { code: 'age_confirmation_requires_user' });
      } });
  }
  return handlers;
}

/** Replicates v3's navigationActions offerable set against v5 controls.
 * Find-merchant stage: only navigationUrl links to the target store (or
 * search/category routes) plus the search input. Find-product stage
 * (pathname === target store path): category rows, the exact-product tile
 * controls, and the homepage link — never another store's page or a
 * product whose ids differ from the validated target. */
export function glovoFilterControls(task) {
  const target = new URL(task.targetUrl);
  const wanted = normalize(task.product);
  return (data, controls) => {
    let insideStore = false;
    try { insideStore = new URL(data.url).pathname === target.pathname; } catch { return []; }
    return controls.filter(control => {
      if (control.tag === 'a') {
        let link;
        try { link = new URL(control.href || '', data.url); } catch { return false; }
        if (!glovoNavigationUrl(link.href)) return false;
        if (link.pathname.includes('/stores/') && link.pathname !== target.pathname) return false;
        if (insideStore && link.pathname !== target.pathname && link.href !== task.startUrl) return false;
        if (link.searchParams.has('productId')
          && (link.searchParams.get('productId') !== target.searchParams.get('productId')
            || link.searchParams.get('externalProductId') !== target.searchParams.get('externalProductId'))) return false;
        return true;
      }
      if (control.tag === 'input') {
        // Only the search field is ever offered — exactly as navigationActions.
        const isSearch = control.type === 'search' && /wyszuk|szuk|search/i.test(control.what);
        // In-store search is a false affordance on this route: Enter lands on
        // ?search= (unfiltered menu) and typed fills never surfaced a product
        // in any observed run — it only burns steps. The category→subcategory
        // path is the reliable one; homepage search stays (it finds stores).
        return isSearch && !insideStore;
      }
      if (['h3', 'p'].includes(control.tag)) {
        if (!insideStore) return false;
        if (control.purpose === 'category') return true;
        // The exact product title IS the gate — an h3/p reading exactly the
        // target name inside the store is the product row whether it sits in
        // a menu tile, a category row, or a search-result list whose
        // container classes may not be in the purpose map. Price paragraphs
        // and neighbouring products never match the exact title.
        return normalize(control.what) === wanted;
      }
      // v3 offered no other control kind: buttons and role-pseudo controls
      // can navigate via JavaScript to destinations the link rules cannot
      // audit — they are never candidates on the read-only route.
      return false;
    });
  };
}

/** Build the validated v5 spec for the authorized Kraków navigation task.
 * done_when encodes the URL half of verification; the adapter verifies the
 * full contract (store + both ids + visible exact title) independently after
 * the loop. */
export function glovoSpec(task, { authorizeAgeConfirmation = false, expectedAddress } = {}) {
  const target = new URL(task.targetUrl);
  const productId = target.searchParams.get('productId');
  const externalId = target.searchParams.get('externalProductId');
  // v3's navigationActions exclusions, split by enforcement layer: `deny`
  // removes them inside the page (they never occupy the control cap — a
  // busy store carries ~80 "Dodaj" buttons), `avoid` keeps the same terms
  // out of the candidate set at component level.
  const exclusions = [
    'dodaj', 'increase', 'decrease', 'remove', 'koszyk', 'basket', 'cart',
    'zapła', 'zamów', 'subscribe', 'prime', 'account', 'profil', 'adres',
    'address', 'login', 'zaloguj',
    // Consent controls are always hidden from the model: when authorized,
    // the deterministic handler acts on the dialog directly; otherwise the
    // age gate ends the run. The model never sees a consent option.
    'zaakceptuj', 'potwierdź', 'pełnoletn', '18 lat'];
  return {
    goal: task.instruction
      || `From the Kraków Glovo homepage, find the store "${task.merchant}" and open the product "${task.product}" to view its details. Browse only — never add to a basket, schedule an order or purchase.`,
    doneWhen: [
      `url=/stores/`,
      `url=productId=${productId}`,
      `url=externalProductId=${externalId}`,
      // The product modal's title element isn't guaranteed to be an h1–h3 —
      // visible page text is the reliable finish signal; verifyGlovo still
      // re-checks the exact title independently after the loop.
      `text=${task.product}`,
    ],
    values: {
      merchant_query: { text: task.merchant, reveal: true },
      product_query: { text: task.product, reveal: true },
    },
    targetText: task.product,
    // Page knowledge, not route orders (memory-lint style): describe what
    // Glovo pages contain so the picker recognizes affordances — the model
    // still decides each step.
    notes: [
      'Glovo store menus group products under category rows, then subcategory rows; product tiles (h3 headings) appear inside the subcategory page.',
      'A product sits under the category/subcategory row matching its type — e.g. a rum product under a Rum row.',
      'Closed-store and age-verification dialogs are dismissed automatically when authorized.',
    ],
    // Glovo product titles are h3/p pseudo-controls; search results may use
    // container classes outside the purpose map, so every h3/p is scanned —
    // the exact-title gate in filterControls decides which are candidates.
    extraControls: 'h3,p',
    componentSelector: '[class*="ItemTile_itemTile"],[class*="ItemRow_itemRow"],[class*="StoreMenuItem_listItem"]',
    purposeMap: [
      { purpose: 'product', selector: '[class*="ItemTile_itemTile"],[class*="ItemRow_itemRow"]' },
      { purpose: 'category', selector: '[class*="StoreMenuItem_listItem"]' },
    ],
    filterControls: glovoFilterControls(task),
    handlers: glovoHandlers(task, { authorizeAgeConfirmation }),
    cap: 400,
    policy: {
      deny: ['checkout', 'payment', 'pay', 'pay now', 'purchase', 'buy now', 'place order',
        'zamów i zapłać', 'delete account', 'log out', 'sign out', ...exclusions],
      avoid: exclusions,
      denyPath: 'checkout|orders?|payments?|transactions?|account|profil|koszyk|cart|basket|address|adres|login|zaloguj',
      operations: ['click', 'fill', 'press', 'scroll_down', 'scroll_up', 'go_back', 'wait', 'done', 'blocked'],
    },
    expectedAddress,
  };
}

/** Post-loop independent verification: the full v3 contract — store slug,
 * productId, externalProductId and the visible exact product title — re-read
 * from the live page, never from the runtime's own status. */
export async function verifyGlovo(page, task) {
  const observation = { ...await page.locator('body').evaluate(readNavigationDom), url: page.url() };
  return verifyNavigation(observation, task);
}
