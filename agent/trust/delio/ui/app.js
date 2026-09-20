import { filterCatalogueItems, visibleRegionalOffer, productImageUrl } from './catalogue-view.mjs';

const $ = (id) => document.getElementById(id);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const array = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const human = (value) => text(value).replace(/[_-]+/g, ' ').replace(/^./, char => char.toUpperCase());
const json = (value) => JSON.stringify(value ?? {}, null, 2);
const hasAmount = (value) => Number.isSafeInteger(value);
const money = (minor, currency = 'PLN') => hasAmount(minor) ? `${new Intl.NumberFormat('en-GB', {minimumFractionDigits:minor % 100 ? 2 : 0, maximumFractionDigits:2}).format(minor / 100)} ${text(currency, 'PLN')}` : 'Not yet verified';
const timestamp = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const number = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(number === null ? value : number < 1e12 ? number * 1000 : number);
  return Number.isFinite(date.getTime()) ? date : null;
};
const dateText = (value) => timestamp(value)?.toLocaleString('en-GB', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', second:'2-digit', timeZoneName:'short'}) || 'Not supplied';

let workspace = {authenticated:false, state:{}, catalog:{}, access:{}, pricing:{}, costs:{}};
let busy = 'Reading access and catalog';
let filter = '';
let browsingRegion = '';
let categoryFilter = '';
let acceptedQuoteId = null;
let previewOpen = false;
let expiryTimer;
let stockExpiryTimer;
const errors = [];
const state = () => object(workspace.state);
const quote = () => object(state().quote);
const catalog = () => Array.isArray(workspace.catalog) ? {items:workspace.catalog} : object(workspace.catalog);
const products = () => array(catalog().items || catalog().products).filter(item => item && typeof item === 'object');
const lines = () => array(state().cart?.lines).filter(line => line && line.productId != null && Number.isSafeInteger(line.quantity) && line.quantity > 0);
const productId = (product) => product.productId == null ? '' : String(product.productId);
const findProduct = (id) => products().find(product => productId(product) === String(id));
const productTitle = (product) => text(product?.title, text(product?.name, product?.productId == null ? 'Observed product' : `Product ${product.productId}`));
const unitPrice = (product) => hasAmount(product?.priceMinor) ? product.priceMinor : hasAmount(product?.unitPriceMinor) ? product.unitPriceMinor : null;
const quantity = (id) => lines().find(line => String(line.productId) === String(id))?.quantity || 0;
const versionKnown = () => Number.isSafeInteger(state().version) && state().version >= 0;
const usageStopped = () => state().stopped === true || Boolean(state().stopped && typeof state().stopped === 'object') || state().usage?.stopped === true;
const accessBlocked = () => workspace.authenticated !== true || !workspace.access?.status || ['blocked','unknown','unobserved','login_required','authentication_required','manual_setup_required','challenge_required','unavailable','needs_login'].includes(workspace.access?.status) || array(workspace.access?.blockers).length > 0;
const canEdit = () => workspace.authenticated === true && !accessBlocked() && versionKnown() && !usageStopped() && state().cart?.status !== 'needs_reconciliation';
const quoteExpired = () => Boolean(timestamp(quote().expiresAt) && timestamp(quote().expiresAt).getTime() <= Date.now());
const quoteCurrent = () => quote().version === state().version;
const quoteVerified = () => ['verified','checkout_verified'].includes(quote().status);
const authorized = () => state().authorization?.status === 'authorized' && state().authorization.quoteId === quote().quoteId && state().authorization.version === state().version;
const canAuthorize = () => canEdit() && !accessBlocked() && quoteVerified() && quoteCurrent() && !quoteExpired() && Boolean(timestamp(quote().expiresAt)) && Boolean(quote().quoteId) && hasAmount(quote().amounts?.totalMinor) && !authorized();

function safeURL(raw, {local = false, preview = false} = {}) {
  if (typeof raw !== 'string' || !raw || raw.startsWith('//')) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
    if (local && url.origin !== window.location.origin) return null;
    if (preview && !/^\/(?:artifacts|previews)\//.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function retainError(code, detail) {
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/i.test(String(code)) ? String(code) : 'request_failed';
  const messages = {
    network_error:'The local server could not be reached. The last known state is retained. No automatic retry was made.',
    invalid_response:'The server returned an unreadable response. No further action was submitted.',
    version_conflict:'The cart changed before this request completed. Review the latest cart before trying again.',
    stale_version:'This request used an older cart version. Review the latest cart before continuing.',
    quote_expired:'This quote has expired. Prepare a fresh quote before authorizing.',
    quote_not_verified:'Checkout has not verified these amounts. This estimate cannot be authorized.',
    needs_reconciliation:'The merchant cart needs to be read again before it can be changed.',
    usage_limit:'The allowance for this quote has been reached. Work has stopped.',
    invalid_quantity:'Use a whole-number quantity within the displayed limit, or remove the item.',
    authentication_required:'Local operator authentication is required. No merchant browser was started by this page.',
  };
  errors.push({at:new Date().toISOString(), code:safeCode, message:messages[safeCode] || (typeof detail === 'string' ? detail.slice(0,700) : `The request was stopped: ${human(safeCode).toLowerCase()}.`)});
}

function applyPayload(payload) {
  const oldQuoteId = quote().quoteId;
  if (payload.authenticated === false) {
    workspace={authenticated:false,state:{},catalog:{},access:{},pricing:{},costs:{}};
    acceptedQuoteId=null; previewOpen=false;
  }
  for (const key of ['authenticated','state','catalog','access','pricing','costs','preview','promotion']) {
    if (Object.hasOwn(payload, key)) workspace[key] = payload[key];
  }
  if (oldQuoteId !== quote().quoteId) acceptedQuoteId = null;
  if (workspace.authenticated !== true) previewOpen = false;
}

async function request(path, body, method) {
  let response;
  try {
    response = await fetch(path, {method:method || (body === undefined ? 'GET' : 'POST'), credentials:'same-origin', cache:'no-store', ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})});
  } catch { throw Object.assign(new Error('network_error'), {code:'network_error'}); }
  let payload;
  try { payload = await response.json(); } catch { throw Object.assign(new Error('invalid_response'), {code:'invalid_response'}); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('invalid_response'), {code:'invalid_response'});
  applyPayload(payload);
  if (!response.ok || payload.ok === false) {
    // Admission errors use only a bounded code; an access code must never be echoed.
    retainError(payload.code || `http_${response.status}`, path === '/api/session' ? undefined : typeof payload.error === 'string' ? payload.error : payload.error?.message);
    return false;
  }
  return true;
}

function renderStatus() {
  const stopped = usageStopped();
  const node = $('live-status');
  node.dataset.tone = busy ? 'busy' : stopped ? 'error' : authorized() ? 'success' : '';
  node.textContent = busy ? `${busy}…` : stopped ? 'Work has stopped at the configured allowance or safety boundary.' : authorized() ? 'This exact quote is authorized. No merchant purchase is claimed by this screen.' : workspace.authenticated !== true ? 'Operator authentication is required before starting merchant work.' : state().cart?.status === 'needs_reconciliation' ? 'The saved basket needs a fresh merchant check before any change.' : 'Review the current cart and price evidence before continuing.';
  $('errors').innerHTML = errors.length ? `<details class="error-history" open><summary>${errors.length} stopped or failed ${errors.length === 1 ? 'request' : 'requests'} · retained for review</summary><ol>${errors.map(error => `<li>${escape(error.message)}<small>${escape(dateText(error.at))} · ${escape(human(error.code))}</small></li>`).join('')}</ol></details>` : '';
}

function renderAccess() {
  const access = object(workspace.access);
  const authenticated = workspace.authenticated === true;
  const blocked = accessBlocked();
  const blockers = array(access.blockers);
  const title = !authenticated ? 'Local operator sign-in is required' : blocked ? 'Merchant access needs attention' : access.status ? 'Account access reported by the server' : 'Merchant access has not been confirmed';
  const description = !authenticated ? 'Enter the access code supplied by the local operator. This admits you to the workspace; it is not a wallet login or a Delio password. No merchant browser starts anonymously.' : blocked ? 'The server reports the blockers below. Products or cached prices do not establish checkout access.' : 'Local operator authentication and merchant account access are separate from wallet connection or payment approval.';
  $('access-panel').dataset.tone = blocked || !access.status ? 'blocked' : 'ready';
  $('access-panel').innerHTML = `<div class="access-topline"><div><h2 id="access-heading">${escape(title)}</h2><p>${escape(description)}</p></div><div class="access-buttons"><button class="secondary-button" data-action="refresh">Refresh saved state ↻</button>${authenticated ? '<button class="secondary-button" data-action="check-access">Check merchant access</button><button class="secondary-button" data-action="logout">Sign out</button>' : ''}</div></div>${!authenticated ? '<form id="admission-form" class="admission-form" autocomplete="off"><label for="access-code">Local operator access code<input id="access-code" name="accessCode" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="256" required></label><button class="secondary-button" type="submit" data-admission>Open my workspace →</button><p>The code is sent only to the local server and cleared from this form. No browser storage is used.</p></form>' : ''}${blockers.length ? `<ul>${blockers.map(blocker => `<li>${escape(typeof blocker === 'string' ? blocker : blocker.message || blocker.reason || human(blocker.code) || 'Manual setup is required.')}</li>`).join('')}</ul>` : ''}${access.status ? `<p>Merchant access: ${escape(human(access.status))}${access.location ? ` · Location: ${escape(typeof access.location === 'string' ? access.location : access.location.label || access.location.name || 'Supplied by server')}` : ''}</p>` : ''}${access.challenge ? '<p>A server-reported access challenge is pending. Use the operator’s private server browser for manual login. OTP entry will appear only when a supported challenge is provided.</p>' : ''}`;
}

function renderUsage() {
  const usage = object(state().usage);
  const limits = object(state().limits);
  const costs = object(workspace.costs);
  const facts = [];
  if (hasAmount(workspace.pricing?.buenaFeeMinor)) facts.push(`<span>Buena service fee <strong>${escape(money(workspace.pricing.buenaFeeMinor, workspace.pricing.currency || 'PLN'))}</strong> · ${workspace.pricing.accepted === true ? 'acceptance recorded' : 'not yet accepted'}</span>`);
  const fields = [ ['liveQuotes','liveQuotes','Live quotes'], ['cartUpdates','cartUpdates','Cart updates'], ['modelCalls','modelCalls','Model calls'] ];
  for (const [used,limit,label] of fields) if (Number.isFinite(usage[used]) || Number.isFinite(limits[limit])) facts.push(`<span>${label} <strong>${Number.isFinite(usage[used]) ? escape(usage[used]) : '—'}${Number.isFinite(limits[limit]) ? ` / ${escape(limits[limit])}` : ''}</strong></span>`);
  if (Number.isFinite(usage.runtimeMs) || Number.isFinite(limits.runtimeMs)) facts.push(`<span>Runtime <strong>${Number.isFinite(usage.runtimeMs) ? escape((usage.runtimeMs / 1000).toFixed(1)) : '—'}${Number.isFinite(limits.runtimeMs) ? ` / ${escape((limits.runtimeMs / 1000).toFixed(1))}` : ''} s</strong></span>`);
  if (typeof costs.knownModelCostUsd === 'number') facts.push(`<span>Known model cost <strong>USD ${escape(costs.knownModelCostUsd.toFixed(6))}</strong></span>`);
  if (typeof costs.estimatedModelCostUsd === 'number') facts.push(`<span>Estimated model cost <strong>USD ${escape(costs.estimatedModelCostUsd.toFixed(6))}</strong></span>`);
  if (Number.isFinite(costs.unknownAttempts) && costs.unknownAttempts > 0) facts.push(`<span>${escape(costs.unknownAttempts)} attempts with unknown cost</span>`);
  if (!Object.keys(limits).length) facts.push('<span>Per-quote allowance: not supplied yet</span>');
  else facts.push('<span>Per-quote limits are recorded below; work stops at the configured boundary.</span>');
  if (usageStopped()) facts.push(`<span class="usage-stop">Stopped: ${escape(typeof state().stopped === 'object' ? state().stopped.reason || state().stopped.code || 'Configured boundary reached' : 'Configured boundary reached')}. No automatic restart.</span>`);
  $('usage-panel').innerHTML = facts.join('');
}

function quantityControl(id, amount, disabled = false) {
  const max = Number.isSafeInteger(findProduct(id)?.maxQuantity) ? findProduct(id).maxQuantity : 99;
  return `<div class="quantity-control"><button data-action="quantity" data-id="${escape(id)}" data-quantity="${amount - 1}" aria-label="Decrease quantity" ${disabled || amount <= 0 ? 'disabled' : ''}>−</button><input data-quantity-input data-id="${escape(id)}" aria-label="Quantity of ${escape(productTitle(findProduct(id) || {productId:id}))}" type="number" min="0" max="${max}" step="1" value="${amount}" ${disabled ? 'disabled' : ''}><button data-action="quantity" data-id="${escape(id)}" data-quantity="${amount + 1}" aria-label="Increase quantity" ${disabled || amount >= max ? 'disabled' : ''}>+</button></div>`;
}

function stockLabel(product) {
  const offer = visibleRegionalOffer(product, {regionId:browsingRegion});
  if (offer?.status === 'unavailable') return {label:'Observed unavailable for delivery', unavailable:true};
  if (offer?.status === 'available') return {label:'Recently observed for delivery', unavailable:false};
  return {label:browsingRegion ? 'Stock for this area not verified' : 'Choose area · stock unknown', unavailable:false};
}

function renderCatalog() {
  clearTimeout(stockExpiryTimer);
  const source = catalog();
  const items = products();
  const regions = array(source.regions);
  const categories = array(source.categories);
  if (!regions.some(region => region.id === browsingRegion)) browsingRegion = '';
  if (!categories.some(category => category.id === categoryFilter)) categoryFilter = '';
  $('catalog-region').innerHTML = '<option value="">Choose an area</option>' + regions.map(region => `<option value="${escape(region.id)}" ${region.id === browsingRegion ? 'selected' : ''}>${escape(region.label)}</option>`).join('');
  $('catalog-category').innerHTML = '<option value="">All categories</option>' + categories.map(category => `<option value="${escape(category.id)}" ${category.id === categoryFilter ? 'selected' : ''}>${escape(category.label)}</option>`).join('');
  const regionLabel = regions.find(region => region.id === browsingRegion)?.label;
  $('catalog-region-note').textContent = regionLabel ? `${regionLabel} is your browsing area only. This public selection is not verified local inventory. Stock and prices require a fresh check for your account, delivery address and fulfillment area.` : 'Choose a browsing area. No region is selected and no stock is verified. This public selection does not establish availability everywhere.';
  const filtered = filterCatalogueItems(items, {query:filter, categoryId:categoryFilter});
  $('catalog-count').textContent = `${filtered.length} / ${items.length} catalogue items`;
  const sourceUrl = safeURL(source.sourceUrl || source.sourceURL || source.url);
  $('catalog-context').innerHTML = `<span>Public catalogue cache</span>${source.personalized === false ? '<span>Not account-specific</span>' : ''}<span>Delivery location not confirmed by browsing choice</span>${source.cacheRetrievedAt ? `<span>Cache retrieved ${escape(dateText(source.cacheRetrievedAt))}</span>` : ''}${sourceUrl ? `<a href="${escape(sourceUrl)}" target="_blank" rel="noopener noreferrer">Catalogue source ↗</a>` : ''}`;
  $('catalog-search').disabled = items.length === 0;
  $('catalog').innerHTML = filtered.length ? filtered.map(product => {
    const id = productId(product);
    const qty = quantity(id);
    const stock = stockLabel(product);
    const disabled = !canEdit() || !id;
    const url = safeURL(product.sourceUrl || product.sourceURL || product.url);
    const observed = product.observedAt || source.observedAt;
    const image = productImageUrl(product);
    const offer = visibleRegionalOffer(product, {regionId:browsingRegion});
    const price = offer ? offer.unitPriceMinor : unitPrice(product);
    const photoSource = safeURL(product.imageSourceUrl);
    return `<article class="product"><div class="product-main"><div class="product-photo"><span class="photo-fallback">Photo unavailable</span>${image ? `<img src="${escape(image)}" alt="${escape(product.imageAlt || productTitle(product))}" width="144" height="128" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</div><div class="product-top"><div><h3>${escape(productTitle(product))}</h3><p class="product-pack">${escape(product.packSize || product.packageSize || 'Pack size not supplied')}</p></div><div class="product-price">${escape(money(price, product.currency || source.currency || 'PLN'))}<small>${offer ? 'Recently observed area price' : 'Cached price · area unverified'}</small></div></div></div><div class="product-bottom"><div class="product-meta"><span class="tag ${stock.unavailable ? 'unavailable' : ''}">${escape(stock.label)}</span><span class="tag estimated">Checkout unverified</span></div>${qty ? quantityControl(id,qty,disabled) : `<button class="add-button" data-action="quantity" data-id="${escape(id)}" data-quantity="1" ${disabled || stock.unavailable ? 'disabled' : ''}>Add +</button>`}</div><details><summary>Source, product ID and freshness</summary><p>Product ID: <code>${escape(id || 'Not supplied')}</code></p><p>Checkout observed: ${escape(dateText(observed))}</p>${offer ? `<p>Stock observed: ${escape(dateText(offer.observedAt))}; valid until ${escape(dateText(offer.validUntil))}. Recheck at checkout.</p>` : '<p>No fresh stock observation for this delivery area.</p>'}<p>${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">Product source ↗</a>` : 'Product source URL not supplied.'}</p>${photoSource ? `<p>Photo link retrieved ${escape(dateText(product.imageRetrievedAt))} from <a href="${escape(photoSource)}" target="_blank" rel="noopener noreferrer">public source ↗</a>. Photo does not verify stock.</p>` : ''}</details></article>`;
  }).join('') : `<div class="empty-state"><div class="empty-icon" aria-hidden="true">${items.length ? '⌕' : '＋'}</div><h3>${items.length ? 'No products match this filter' : 'No public catalogue is available'}</h3><p>${items.length ? 'Try a different product name or clear your filters.' : 'The server must supply a public product cache before items appear here.'}</p></div>`;
  $('catalog').querySelectorAll('.product-photo img').forEach(img => {
    const loaded = () => { img.parentElement.classList.add('photo-loaded'); };
    const failed = () => { img.remove(); };
    img.addEventListener('load', loaded, {once:true});
    img.addEventListener('error', failed, {once:true});
    if (img.complete) { if (img.naturalWidth > 0) loaded(); else failed(); }
  });
  const expiries = items.map(product => visibleRegionalOffer(product, {regionId:browsingRegion})?.validUntil).filter(Number.isSafeInteger);
  if (expiries.length) stockExpiryTimer = setTimeout(() => {renderCatalog(); disableBusy();}, Math.max(1, Math.min(...expiries) - Date.now() + 10));
}

function renderCart() {
  const cartLines = lines();
  const itemCount = cartLines.reduce((sum,line) => sum + line.quantity, 0);
  $('cart-count').textContent = state().cart?.status === 'observed' ? `${itemCount} ${itemCount === 1 ? 'item' : 'items'}` : 'Not verified';
  let knownSubtotal = 0;
  let allPricesKnown = cartLines.length > 0;
  $('cart').innerHTML = cartLines.length ? `<ul class="cart-lines">${cartLines.map(line => {
    const product = findProduct(line.productId) || line;
    const price = unitPrice(product);
    const total = hasAmount(line.totalMinor) ? line.totalMinor : hasAmount(price) ? price * line.quantity : null;
    if (hasAmount(total)) knownSubtotal += total; else allPricesKnown = false;
    return `<li class="cart-line"><div><h3>${escape(productTitle(product))}</h3><p>${escape(product.packSize || product.packageSize || `Product ID: ${line.productId}`)}</p></div><span class="cart-line-price">${escape(money(total,product.currency || 'PLN'))}</span><div class="cart-line-bottom">${quantityControl(String(line.productId),line.quantity,!canEdit())}<button class="remove-button" data-action="quantity" data-id="${escape(line.productId)}" data-quantity="0" ${!canEdit() ? 'disabled' : ''}>Remove</button></div></li>`;
  }).join('')}</ul><div class="cart-subtotal"><span>Estimated item subtotal</span><strong>${allPricesKnown ? escape(money(knownSubtotal, catalog().currency || 'PLN')) : 'Not yet verified'}</strong></div>` : state().cart?.status === 'observed' ? '<p class="cart-empty">Your observed basket is empty. Add products to start a quote.</p>' : '<p class="cart-empty">Your merchant basket has not been verified. Check account access before preparing a quote.</p>';
  const needsRead = state().cart?.status === 'needs_reconciliation';
  $('quote-action').innerHTML = needsRead ? `<div class="quote-blocker">The saved basket needs reconciliation. Read the merchant basket before making another change.</div><button class="primary-button" data-action="reconcile" ${accessBlocked() || usageStopped() ? 'disabled' : ''}>Check existing cart<span class="arrow" aria-hidden="true">↻</span></button><p class="button-note">Reads merchant state. It does not repeat the uncertain mutation.</p>` : `<button class="primary-button" data-action="quote" ${!canEdit() || accessBlocked() || !cartLines.length ? 'disabled' : ''}>Prepare a fresh quote<span class="arrow" aria-hidden="true">→</span></button><p class="button-note">Checks the item lines and checkout charges. Does not submit a merchant order. ${accessBlocked() ? 'Merchant access must be available first.' : ''}</p>`;
}

function renderQuote() {
  clearTimeout(expiryTimer);
  const current = quote();
  if (!current.quoteId) {
    $('quote-status').textContent = 'Not prepared';
    $('quote').innerHTML = '<p class="quote-empty">Your quote will show item prices, coupon results, deposits, delivery and all mandatory fees separately. No discount or delivery charge is assumed.</p>';
    return;
  }
  const amounts = object(current.amounts);
  const currency = current.currency || 'PLN';
  const expired = quoteExpired();
  const verified = quoteVerified();
  const isCurrent = quoteCurrent();
  $('quote-status').textContent = authorized() ? 'Authorized' : expired ? 'Expired' : !isCurrent ? 'Old cart version' : verified ? 'Checkout verified' : 'Estimated';
  const feeRows = [['Items','itemSubtotalMinor'],['Deposits','depositsMinor'],['Delivery','deliveryFeeMinor'],['Merchant service fee','serviceFeeMinor'],['Small-order fee','smallOrderFeeMinor'],['Other mandatory fees','otherFeesMinor'],['Discounts','discountMinor'],['Merchant total','merchantTotalMinor'],['Buena service fee','buenaFeeMinor']];
  const coupons = array(current.coupons || current.couponResults);
  const consent = acceptedQuoteId === current.quoteId;
  const blockers = [!verified ? 'This is an estimate. Checkout verification is required before authorization.' : '',!isCurrent ? 'The cart has changed since this quote. Prepare a new quote.' : '',expired ? 'The quote has expired. Prepare a fresh quote.' : '',!timestamp(current.expiresAt) ? 'No valid expiry was supplied. Authorization is unavailable.' : '',usageStopped() ? 'The quote allowance or safety boundary has stopped further work.' : ''].filter(Boolean);
  $('quote').innerHTML = `<div class="quote-grade ${verified ? 'verified' : ''}"><strong>${verified ? 'Checkout-verified quote' : 'Estimated quote'}</strong>${verified ? 'The server reports these amounts were observed at checkout. Confirm the freshness and cart version below.' : 'These amounts do not establish the final checkout total. No purchase permission is requested for an estimate.'}</div><div class="quote-amount">${escape(money(amounts.totalMinor,currency))}</div><p class="quote-amount-caption">Total including Buena’s service fee</p><dl class="quote-breakdown">${feeRows.map(([label,key]) => `<div class="${key === 'buenaFeeMinor' ? 'fee-row' : ''}"><dt>${label}</dt><dd>${key === 'discountMinor' && hasAmount(amounts[key]) && amounts[key] > 0 ? '−' : ''}${escape(money(amounts[key],currency))}</dd></div>`).join('')}<div class="total-row"><dt>Exact total</dt><dd>${escape(money(amounts.totalMinor,currency))}</dd></div></dl>${coupons.length ? `<ul class="coupon-list">${coupons.map(coupon => `<li class="${coupon.accepted === false || coupon.status === 'rejected' ? 'rejected' : ''}"><strong>${escape(coupon.code || coupon.label || 'Coupon')}</strong> · ${escape(coupon.accepted === true ? 'Accepted' : coupon.accepted === false ? 'Rejected' : human(coupon.status) || 'Not verified')}${coupon.reason ? `<br>${escape(coupon.reason)}` : ''}${hasAmount(coupon.discountMinor) ? `<br>Discount: ${escape(money(coupon.discountMinor,currency))}` : ''}</li>`).join('')}</ul>` : '<p class="button-note">No coupon result was supplied. No promotional discount is assumed.</p>'}<div class="quote-freshness ${expired ? 'expired' : ''}">Observed ${escape(dateText(current.observedAt))}<br>Expires ${escape(dateText(current.expiresAt))}<br>Quote version ${escape(current.version ?? 'Not supplied')} · current cart version ${escape(state().version ?? 'Not supplied')}</div><details class="quote-terms"><summary>Inspect quoted items and evidence references</summary>${array(current.lines).length ? `<ul class="quote-items">${array(current.lines).map(line => `<li>${escape(productTitle(line.title || line.name ? line : findProduct(line.productId) || line))} · quantity ${escape(line.quantity ?? 'Not supplied')}${hasAmount(line.totalMinor) ? ` · ${escape(money(line.totalMinor,currency))}` : ''}<br><code>Product ID: ${escape(line.productId ?? 'Not supplied')}</code></li>`).join('')}</ul>` : '<p>No quote item lines were supplied.</p>'}<pre>${escape(json({quoteId:current.quoteId,version:current.version,evidenceRefs:current.evidenceRefs}))}</pre></details>${blockers.length ? `<div class="quote-blocker">${blockers.map(escape).join('<br>')}</div>` : ''}${authorized() ? '<div class="authorized-note"><strong>Exact quote authorization recorded.</strong><br>Local LiteSVM authorization only. This is not a real wallet, public-chain payment or merchant order.</div>' : `<label class="approval-check"><input id="fee-consent" type="checkbox" ${consent ? 'checked' : ''} ${!canAuthorize() ? 'disabled' : ''}><span>I approve this exact ${escape(money(amounts.totalMinor,currency))} quote, including the separate ${escape(money(amounts.buenaFeeMinor,currency))} Buena service fee.</span></label><button class="primary-button" data-action="authorize" ${!canAuthorize() || !consent || !hasAmount(amounts.buenaFeeMinor) ? 'disabled' : ''}>Authorize on local LiteSVM<span class="arrow" aria-hidden="true">→</span></button><p class="button-note">This asks the server to authorize the exact quote in local LiteSVM. No real wallet, payment or merchant order is involved.</p>`}`;
  const expires = timestamp(current.expiresAt);
  if (expires && expires.getTime() > Date.now()) expiryTimer = setTimeout(() => {renderQuote(); disableBusy();}, Math.min(expires.getTime() - Date.now() + 25, 2147483647));
}

function renderRecords() {
  const current = state();
  const events = array(current.events);
  $('records').innerHTML = `<details class="record-detail"><summary>Cart observations <span>Version ${escape(current.version ?? 'not supplied')} · ${escape(human(current.cart?.status) || 'Not observed')}</span></summary><pre>${escape(json(current.cart || {}))}</pre></details><details class="record-detail"><summary>Quote and authorization <span>Exact item lines, fees and permission</span></summary><pre>${escape(json({quote:current.quote || null,authorization:current.authorization || null}))}</pre></details><details class="record-detail"><summary>Usage allowance and costs <span>Reported values only</span></summary><pre>${escape(json({usage:current.usage || {},limits:current.limits || {},stopped:current.stopped ?? false,costs:workspace.costs || {}}))}</pre></details>${events.length ? `<details class="record-detail"><summary>Activity <span>${events.length} recorded events</span></summary><ol class="event-list">${events.map(event => `<li><time>${escape(dateText(event.at))}</time><span>${escape(event.message || human(event.type))}</span></li>`).join('')}</ol></details>` : ''}`;
  const link = $('evidence-link');
  if (workspace.authenticated === true) { link.setAttribute('href','/api/evidence'); link.removeAttribute('aria-disabled'); link.removeAttribute('tabindex'); }
  else { link.removeAttribute('href'); link.setAttribute('aria-disabled','true'); link.setAttribute('tabindex','-1'); }
  const preview = object(workspace.preview || current.preview);
  const url = workspace.authenticated === true && preview.redacted === true ? safeURL(preview.url,{local:true,preview:true}) : null;
  $('preview').innerHTML = url ? `<div class="preview-card"><button class="secondary-button" data-action="preview">${previewOpen ? 'Hide' : 'Open'} private redacted preview</button><p>Optional server-provided preview. Account and checkout details are redacted by the server.</p>${previewOpen ? `<img src="${escape(url)}" alt="Private redacted merchant observation">` : ''}</div>` : '';
}

function disableBusy() {
  document.querySelectorAll('button[data-action],input[data-quantity-input],#fee-consent,#access-code,[data-admission]').forEach(node => { node.disabled = Boolean(busy) || node.disabled; });
  document.querySelector('main').setAttribute('aria-busy',String(Boolean(busy)));
}

function render() {
  const promotion=workspace.promotion;
  $('promotion-panel').hidden=!promotion;
  if(promotion)$('promotion-panel').innerHTML=`<h2>Receipt coupon ${escape(promotion.code)}</h2><p>${escape(money(promotion.advertisedDiscountMinor))} off a first order from ${escape(money(promotion.minimumBasketMinor))}, as printed on the receipt. ${promotion.merchantAccepted?'Checkout accepted this code.':'Saved for checkout verification; no discount has been applied.'}</p><p>Receipt expiry appears to be 18 November 2026; matching promotion terms are still unverified. Current status: ${escape(human(promotion.acceptance))}.</p>`;
  renderStatus(); renderAccess(); renderUsage(); renderCatalog(); renderCart(); renderQuote(); renderRecords(); disableBusy();
}

async function act(action, {id, amount} = {}) {
  if (busy) return;
  if (action === 'preview') { previewOpen = !previewOpen; renderRecords(); return; }
  let path;
  let body;
  let method;
  let label;
  if (action === 'refresh') { path='/api/state'; label='Reading current access and state'; }
  else if (action === 'logout') { path='/api/session'; method='DELETE'; label='Closing the local operator session'; }
  else if (workspace.authenticated !== true) { retainError('authentication_required'); render(); return; }
  else if (action === 'check-access') { path='/api/check-access'; body={}; label='Checking merchant access with the bounded worker'; }
  else if (action === 'quantity') {
    if (!canEdit()) return;
    const product = findProduct(id);
    if (!product && !lines().some(line => String(line.productId) === String(id))) return;
    const max = Number.isSafeInteger(product?.maxQuantity) ? product.maxQuantity : 99;
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > max) { retainError('invalid_quantity'); render(); return; }
    if (amount > quantity(id) && product && stockLabel(product).unavailable) return;
    const updated = lines().map(line => ({productId:line.productId,quantity:line.quantity}));
    const index = updated.findIndex(line => String(line.productId) === String(id));
    if (index >= 0) updated[index] = {productId:updated[index].productId,quantity:amount};
    else updated.push({productId:product.productId,quantity:amount});
    path='/api/cart'; body={version:state().version,lines:updated}; label='Updating the cart and checking the result';
  } else if (action === 'quote') {
    if (!canEdit() || accessBlocked() || !lines().length) return;
    path='/api/quote'; body={version:state().version}; label='Preparing a fresh checkout quote';
  } else if (action === 'reconcile') {
    if (accessBlocked() || usageStopped()) return;
    path='/api/reconcile'; body={}; label='Reading the existing merchant cart';
  } else if (action === 'authorize') {
    if (!canAuthorize() || acceptedQuoteId !== quote().quoteId || !hasAmount(quote().amounts?.buenaFeeMinor)) return;
    path='/api/authorize'; body={quoteId:quote().quoteId,version:state().version}; label='Recording authorization for the exact quote';
  } else return;
  busy=label; render();
  try {
    const ok = await request(path,body,method);
    if (ok && action === 'logout') {
      workspace={authenticated:false,state:{},catalog:workspace.catalog,access:{},pricing:{},costs:{}};
      acceptedQuoteId=null; previewOpen=false;
      await request('/api/state');
    }
  }
  catch (error) { retainError(error.code || 'request_failed'); }
  finally { busy=''; render(); }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (button && !button.disabled) void act(button.dataset.action,{id:button.dataset.id,amount:Number(button.dataset.quantity)});
});
document.addEventListener('change', event => {
  if (event.target.id === 'catalog-region') {
    browsingRegion = event.target.value; renderCatalog(); disableBusy();
  } else if (event.target.id === 'catalog-category') {
    categoryFilter = event.target.value; renderCatalog(); disableBusy();
  } else if (event.target.id === 'fee-consent') {
    acceptedQuoteId = event.target.checked && canAuthorize() ? quote().quoteId : null;
    renderQuote(); disableBusy();
  } else if (event.target.matches('input[data-quantity-input]') && !event.target.disabled) {
    void act('quantity',{id:event.target.dataset.id,amount:Number(event.target.value)});
  }
});
document.addEventListener('submit', async event => {
  if (event.target.id !== 'admission-form') return;
  event.preventDefault();
  if (busy) return;
  const field = $('access-code');
  const accessCode = field.value;
  field.value = '';
  if (!accessCode || accessCode.length > 256) return;
  busy='Checking local operator admission'; render();
  try {
    const ok = await request('/api/session',{accessCode});
    if (ok) await request('/api/state');
  } catch (error) { retainError(error.code || 'request_failed'); }
  finally { busy=''; render(); }
});
$('catalog-search').addEventListener('input', event => {filter=event.target.value; renderCatalog(); disableBusy();});

async function initialize() {
  render();
  try { await request('/api/state'); }
  catch (error) { retainError(error.code || 'request_failed'); }
  finally { busy=''; render(); }
}
void initialize();
