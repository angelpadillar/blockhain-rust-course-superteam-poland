// Policy decisions use executor-observed controls and executor-owned cart state.
// A model's claimed operation/label/ownership is never sufficient evidence.
export class SafetyError extends Error {
  constructor(code) { super(code); this.name = 'SafetyError'; this.code = code; }
}
export const normalize = value => String(value || '').normalize('NFKD').replace(/\p{M}/gu, '')
  .replace(/ł/g, 'l').replace(/Ł/g, 'l').toLowerCase().trim().replace(/\s+/g, ' ');
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const denied = reason => ({ allowed: false, category: 'forbidden', reason });
const accepted = category => ({ allowed: true, category, reason: null });
const dangerousLabel = /\b(?:buy(?: now)?|purchase|pay(?:ment)?|checkout|place (?:your )?order|submit (?:your )?order|complete (?:your )?(?:order|purchase)|proceed to checkout|kup(?: teraz|uje)?|zamow(?:ienie|ienia|ic)?|zamawiam|zloz zamowienie|realizacji zamowienia|do kasy|zaplac|platnosc|platnosci|karta kredytowa|credit card|billing|shipping address|adres dostawy|konto|konta|account|profile|profil|sign in|log in|login|logout|sign out|register|zaloguj|wyloguj|rejestracja|zarejestruj|subscribe|subskrypcja|upload|przeslij plik|wyslij plik)\b/;
const settingsLabel = /\b(?:settings|ustawienia|preferences|preferencje)\b/;
const addLabel = /^(?:add(?: item)? to (?:cart|basket)|add to shopping cart|dodaj(?: produkt)? do koszyka)(?:\s*[(:].*)?$/;
const removeLabel = /^(?:remove(?: (?:this )?item)?|delete|usun(?: (?:ten )?produkt)?|usun z koszyka)$/;
const cartLabel = /^(?:cart|basket|shopping cart|view cart|go to cart|open cart|koszyk|moj koszyk|przejdz do koszyka|zobacz koszyk)(?:\s*\(?\d+\)?)?$/;
const dismissLabel = /^(?:reject(?: all)?|decline(?: all)?|dismiss|close|continue without accepting|necessary only|odrzuc(?: wszystkie)?|nie,? dziekuje|zamknij|tylko niezbedne|kontynuuj bez akceptacji)$/;
const searchLabel = /\b(?:search|find|szukaj|wyszukaj|wyszukiwanie|szukasz)\b/;
const optionLabel = /\b(?:color|colour|size|style|variant|option|model|kolor|rozmiar|styl|wariant|opcja|opcje|wybierz)\b/;
const quantityLabel = /\b(?:quantity|qty|ilosc|liczba sztuk)\b/;
const operations = {
  search: ['fill', 'press', 'click'], open_product: ['click'], choose_option: ['click', 'select'],
  set_quantity: ['fill', 'select', 'click'], add_to_cart: ['click'], remove_own_cart_item: ['click'],
  dismiss_cookie: ['click'], view_cart: ['click'], test_preference: ['click', 'fill', 'select'],
};
const fields = new Set(['ref', 'operation', 'kind', 'label', 'href', 'formAction', 'formMethod', 'inputType', 'value', 'role', 'tag', 'cartItemKey']);
const controlText = value => typeof value === 'string' && value.length <= 1000 && !/[\x00-\x1f]/.test(value);
function scope(context) {
  try {
    const current = new URL(context.currentUrl);
    const origin = context.allowedOrigin || current.origin;
    if (!['http:', 'https:'].includes(current.protocol) || current.origin !== origin || current.username || current.password) return null;
    return { current, origin };
  } catch { return null; }
}
function localTest(context) {
  const site = scope(context);
  return context.allowTestSettings === true && site && /^(?:localhost|127\.0\.0\.1|\[::1\]|[^/]+\.test)$/.test(site.current.hostname);
}
function ownsItem(action, context) {
  const keys = context.ownedCartItemKeys;
  return context.guestSession === true && typeof action.cartItemKey === 'string' && action.cartItemKey.length > 0
    && (keys instanceof Set ? keys.has(action.cartItemKey) : Array.isArray(keys) && keys.includes(action.cartItemKey));
}
function decoded(value) {
  let result = value;
  for (let i = 0; i < 2; i++) { try { const next = decodeURIComponent(result); if (next === result) break; result = next; } catch { return null; } }
  return normalize(result);
}
function inspectUrl(value, context, { cartMutation = false, testSettings = false } = {}) {
  const site = scope(context);
  if (!site) return denied('invalid_scope');
  let url;
  try { url = new URL(value, site.current); } catch { return denied('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== site.origin || url.username || url.password) return denied('outside_origin');
  const path = decoded(url.pathname);
  if (path === null) return denied('invalid_url');
  if (/checkout|check-out|buy-now|buynow|oneclick|one-click|1-click|place.?order|submit.?order|payment|billing|address|account|signin|sign-in|logout|profile|register|zamowien|platnos|logowanie|rejestr|konto|profil/.test(path)
    || /\/(?:buy|purchase|pay|orders?|kasa|upload|delete-account)(?:[/.;-]|$)/.test(path)) return denied('dangerous_endpoint');
  if (/\/(?:settings|preferences|ustawienia)(?:[/.;-]|$)/.test(path) && !(testSettings && localTest(context))) return denied('account_settings_forbidden');
  for (const [key, value] of url.searchParams) {
    const name = normalize(key), argument = decoded(value);
    if (argument === null) return denied('invalid_url');
    if (/checkout|buynow|buy-now|placeorder|submitorder|payment|account|upload/.test(name)) return denied('dangerous_endpoint');
    if (/^(?:action|do|operation|cmd|intent|submit|handler)$/.test(name)) {
      if (dangerousLabel.test(argument) || /checkout|buy.?now|place.?order|submit.?order|payment|account|address|upload/.test(argument)) return denied('dangerous_endpoint');
      if (/\b(?:add|remove|delete|update|setquantity)\b/.test(argument) && !cartMutation) return denied('unscoped_mutation_url');
    }
    if (/^(?:redirect|redirect_url|returnurl|return_url|next|url)$/.test(name)
      && /checkout|buy.?now|orders?|payment|account|address|signin|upload/.test(argument)) return denied('dangerous_endpoint');
  }
  const cartChange = /\/(?:cart|basket|koszyk)\/(?:add|remove|delete|update|set[-_]?quantity)(?:[/.;-]|$)/.test(path)
    || /\/(?:add-to-cart|addtocart|remove-from-cart|handle-buy-box)(?:[/.;-]|$)/.test(path);
  if (cartChange && !cartMutation) return denied('unscoped_mutation_url');
  if (/\/(?:delete|remove)(?:[/.;-]|$)/.test(path) && !(cartMutation && /\/(?:cart|basket|koszyk)\//.test(path))) return denied('destructive_endpoint');
  return { ...accepted('navigation'), url };
}

export function classifyAction(action, context = {}) {
  if (!plain(action) || Object.keys(action).some(key => !fields.has(key))) return denied('unsupported_action_field');
  if (!Object.hasOwn(operations, action.operation) || !operations[action.operation].includes(action.kind)) return denied('unsupported_operation');
  if (!scope(context)) return denied('invalid_scope');
  for (const key of ['label', 'href', 'formAction', 'formMethod', 'inputType', 'role', 'tag', 'cartItemKey', 'ref']) {
    if (action[key] !== undefined && !controlText(action[key])) return denied('invalid_action_metadata');
  }
  if (['file', 'password', 'email', 'tel', 'hidden'].includes(normalize(action.inputType))) return denied('sensitive_input');
  if (action.value !== undefined && !(typeof action.value === 'number' && Number.isFinite(action.value)) && !controlText(action.value)) return denied('invalid_action_value');
  const label = normalize(action.label), testSettings = action.operation === 'test_preference' && localTest(context);
  if (dangerousLabel.test(label)) return denied('dangerous_control');
  if (settingsLabel.test(label) && !testSettings) return denied('account_settings_forbidden');
  const cartMutation = ['add_to_cart', 'remove_own_cart_item'].includes(action.operation)
    || action.operation === 'set_quantity' && context.quantityScope === 'cart';
  if (action.operation === 'set_quantity' && context.quantityScope !== undefined && !['product', 'cart'].includes(context.quantityScope)) return denied('invalid_quantity_scope');
  if (cartMutation && context.guestSession !== true) return denied('guest_session_required');
  if ((action.operation === 'remove_own_cart_item' || action.operation === 'set_quantity' && context.quantityScope === 'cart')
    && !ownsItem(action, context)) return denied('item_not_owned_by_run');
  for (const key of ['href', 'formAction']) if (action[key]) {
    const productField = key === 'formAction' && ['choose_option', 'set_quantity'].includes(action.operation)
      && context.quantityScope !== 'cart';
    const result = inspectUrl(action[key], context, { cartMutation: cartMutation || productField, testSettings });
    if (!result.allowed) return result;
  }
  if (action.operation === 'search') {
    if (!searchLabel.test(label) && normalize(action.inputType) !== 'search' && action.role !== 'searchbox') return denied('search_control_unproven');
    if (action.kind === 'fill' && (typeof action.value !== 'string' || !action.value.trim() || action.value.length > 300)) return denied('invalid_search_value');
    if (action.kind === 'press' && action.value !== 'Enter') return denied('unsupported_key');
    if (action.formMethod && normalize(action.formMethod) !== 'get') return denied('nonread_search_form');
    return accepted('search');
  }
  if (action.operation === 'open_product') {
    if (!action.href || !(action.tag === 'a' || action.role === 'link')) return denied('native_link_required');
    if (removeLabel.test(label) || addLabel.test(label) || cartLabel.test(label)) return denied('operation_label_mismatch');
    return accepted('navigation');
  }
  if (action.operation === 'choose_option') {
    if (!optionLabel.test(label) && context.productOptionContext !== true) return denied('product_option_unproven');
    return accepted('product_option');
  }
  if (action.operation === 'set_quantity') {
    const quantity = Number(action.value), max = context.maxQuantity ?? 10;
    if (!quantityLabel.test(label) && action.inputType !== 'number' && action.role !== 'spinbutton') return denied('quantity_control_unproven');
    if (!Number.isSafeInteger(max) || max < 1 || max > 100 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > max) return denied('quantity_limit');
    return accepted(cartMutation ? 'cart_mutation' : 'product_quantity');
  }
  if (action.operation === 'add_to_cart') return addLabel.test(label) ? accepted('cart_mutation') : denied('add_control_unproven');
  if (action.operation === 'remove_own_cart_item') return removeLabel.test(label) ? accepted('cart_mutation') : denied('remove_control_unproven');
  if (action.operation === 'view_cart') return action.href && cartLabel.test(label) ? accepted('navigation') : denied('cart_link_unproven');
  if (action.operation === 'dismiss_cookie') return dismissLabel.test(label) ? accepted('dismiss') : denied('cookie_dismiss_unproven');
  return testSettings ? accepted('test_preference') : denied('test_settings_forbidden');
}
export function validateAction(action, context) {
  const classification = classifyAction(action, context);
  if (!classification.allowed) throw new SafetyError(classification.reason);
  return Object.freeze({ ...action });
}

// A caller cannot forge a token by copying its public fields. Endpoint and
// remaining-use state stay private and are never returned in diagnostics.
const permits = new WeakMap();
export function createMutationPermit(action, context, { now = Date.now(), ttlMs = 5000 } = {}) {
  const safe = validateAction(action, context), classification = classifyAction(safe, context);
  if (!['cart_mutation', 'test_preference'].includes(classification.category)) throw new SafetyError('mutation_not_authorized');
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 10000 || !Number.isFinite(now)) throw new SafetyError('invalid_permit_limits');
  const endpoint = action.formAction || action.href;
  if (!endpoint) throw new SafetyError('observed_endpoint_required');
  const method = action.formMethod ? action.formMethod.toUpperCase() : action.formAction ? 'POST' : 'GET';
  if (!['GET', 'POST'].includes(method)) throw new SafetyError('unsupported_mutation_method');
  const target = inspectUrl(endpoint, context, { cartMutation: classification.category === 'cart_mutation', testSettings: action.operation === 'test_preference' });
  if (!target.allowed) throw new SafetyError(target.reason);
  target.url.hash = '';
  const token = Object.freeze({ operation: action.operation, method, expiresAt: now + ttlMs });
  permits.set(token, { endpoint: target.url.href, method, expiresAt: token.expiresAt, remaining: 1,
    category: classification.category, context: { ...context } });
  return token;
}
const staticTypes = new Set(['stylesheet', 'image', 'font', 'script', 'media', 'manifest', 'texttrack']);
export function classifyRequest(request, context = {}, { permit, now = Date.now() } = {}) {
  const site = scope(context);
  if (!site || !plain(request)) return { ...denied('invalid_scope'), stop: true };
  const method = String(request.method || '').toUpperCase(), navigation = request.navigation === true;
  let url;
  try { url = new URL(request.url); url.hash = ''; } catch { return { ...denied('invalid_url'), stop: navigation }; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { ...denied('outside_origin'), stop: navigation };
  const entry = permits.get(permit);
  const matching = entry && entry.remaining > 0 && now < entry.expiresAt && entry.method === method && entry.endpoint === url.href;
  const check = inspectUrl(url.href, context, { cartMutation: matching && entry.category === 'cart_mutation', testSettings: matching && entry.category === 'test_preference' });
  if (url.origin !== site.origin) {
    if (!navigation && ['GET', 'HEAD'].includes(method) && staticTypes.has(request.resourceType)) return { ...accepted('passive_resource'), stop: false };
    return { ...denied('outside_origin'), stop: navigation };
  }
  if (!check.allowed) return { ...check, stop: navigation || ['dangerous_endpoint', 'account_settings_forbidden', 'destructive_endpoint'].includes(check.reason) };
  if (matching) return { ...accepted('authorized_mutation'), stop: false };
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return { ...accepted('read'), stop: false };
  return { ...denied('mutation_without_permit'), stop: false };
}

/** Install guard.route with context.route. Call authorize immediately before a
 * validated native dispatch and finishAction after observation. Blocked routine
 * POSTs are counted/aborted without claiming the shopping task failed. */
export function createRequestGuard(context, { onEvent = async () => {}, now = Date.now } = {}) {
  const controller = new AbortController();
  let activePermit = null;
  const counts = { allowed: 0, aborted: 0, unrelatedMutationAborts: 0, dangerousAborts: 0, authorizedMutations: 0 };
  function stop(code) { if (!controller.signal.aborted) controller.abort(new SafetyError(code)); }
  return {
    signal: controller.signal,
    counts,
    throwIfStopped() { controller.signal.throwIfAborted(); },
    authorize(action, actionContext = context) {
      controller.signal.throwIfAborted();
      if (activePermit) permits.get(activePermit).remaining = 0;
      activePermit = createMutationPermit(action, actionContext, { now: now() });
      return activePermit;
    },
    finishAction() { if (activePermit) permits.get(activePermit).remaining = 0; activePermit = null; },
    async route(route) {
      let decision = { ...denied('guard_error'), stop: true }, allow = false;
      try {
        controller.signal.throwIfAborted();
        const request = route.request();
        decision = classifyRequest({ url: request.url(), method: request.method(), navigation: request.isNavigationRequest(), resourceType: request.resourceType() },
          context, { permit: activePermit, now: now() });
        if (decision.allowed && decision.category === 'authorized_mutation') {
          permits.get(activePermit).remaining--; // Reserve before awaiting journal.
          await onEvent({ type: 'mutation_request_authorized', operation: activePermit.operation, method: activePermit.method });
          controller.signal.throwIfAborted(); counts.authorizedMutations++;
        } else if (!decision.allowed) {
          counts.aborted++;
          if (decision.reason === 'mutation_without_permit') counts.unrelatedMutationAborts++;
          if (decision.stop) { counts.dangerousAborts++; stop(decision.reason); }
          await onEvent({ type: 'request_blocked', reason: decision.reason, stop: decision.stop });
        }
        allow = decision.allowed;
        if (allow) counts.allowed++;
      } catch { stop('request_guard_or_journal_failed'); }
      finally {
        if (allow && !controller.signal.aborted) await route.fallback().catch(() => stop('request_interception_failed'));
        else await route.abort('blockedbyclient').catch(() => {});
      }
      return decision;
    },
  };
}
