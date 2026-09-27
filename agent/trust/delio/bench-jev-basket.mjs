// Benchmark: build a >=150 zl basket on the real Delio account, with Jev
// choosing controls among code-extracted candidates (selection:'jev').
// Usage: node bench-jev-basket.mjs [deterministic]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const accessCode = JSON.parse(readFileSync(join(here, 'private/operator.json'), 'utf8')).accessCode;
const MODE = process.argv[2] === 'deterministic' ? undefined : 'jev';

// >=150 zl plan: high-price, coupon-eligible (no alcohol/tobacco/infant),
// few clicks. Stock is gated by the worker's own availableQuantity preflight.
const PLAN = [
  { productId: 'A0016796', quantity: 1 }, // Zel do prania 64.99
  { productId: 'A0024349', quantity: 1 }, // Wonder Wash 64.99
  { productId: 'A0000102', quantity: 1 }, // Lavazza Qualita Oro 30.99 (max 1)
  { productId: 'A0022282', quantity: 1 }, // Ritter 7.99 (known: 37 avail)
  { productId: 'A0025262', quantity: 1 }, // Talarki 4.99 (known: 23 avail)
];
// ~= 176 zl in 5 adds; each gated by the worker's own stock preflight.

const base = 'http://127.0.0.1:4319';
let cookie = '';
const post = async (path, payload) => {
  const t = Date.now();
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(payload) });
  const setC = r.headers.get('set-cookie'); if (setC) cookie = setC.split(';')[0];
  const body = await r.json();
  return { ...body, _ms: Date.now() - t };
};
const lineKey = ls => (ls || []).map(l => `${l.productId}:${l.quantity}`).sort().join(',');
const t0 = Date.now();
const lap = (label, ms) => console.log(`  ${label.padEnd(46)} ${(ms / 1000).toFixed(1)}s`);

console.log(`mode: ${MODE ?? 'deterministic'}  plan: ${PLAN.map(l => l.productId + 'x' + l.quantity).join(', ')}`);

let r = await post('/api/session', { accessCode });
if (!r.ok) { console.log('session failed', r); process.exit(1); }
lap('session', r._ms);

r = await post('/api/reconcile', {});
if (!r.ok) { console.log('reconcile failed', r.code, JSON.stringify(r.blocked || '')); process.exit(1); }
lap(`reconcile (cart: ${lineKey(r.state.cart.lines)})`, r._ms);
let st = r;

const wanted = PLAN, wantKey = lineKey(wanted);
// usage.modelCalls is cumulative on the state — diff against the starting value.
let round = 0, calls0 = st.state.usage?.modelCalls ?? 0;
const jevSoFar = s => Math.max(0, (s.state?.usage?.modelCalls ?? 0) - calls0);
for (; round < 6 && lineKey(st.state.cart.lines) !== wantKey; round++) {
  st = await post('/api/cart', { version: st.state.version, lines: wanted, ...(MODE ? { selection: MODE } : {}) });
  lap(`updateCart round ${round + 1} → ${st.ok ? 'ok' : st.code}${st.blocked ? ' ' + JSON.stringify(st.blocked) : ''} (jev total: ${jevSoFar(st)})`, st._ms);
  if (!st.ok && st.state) { const rc = await post('/api/reconcile', {}); lap('  reconcile', rc._ms); if (rc.ok) st = { ...rc, usage: st.usage }; }
  if (!st.state) break;
}
if (lineKey(st.state.cart.lines) !== wantKey) {
  const got = st.state.cart.lines || [];
  console.log('\nDID NOT CONVERGE');
  console.log('  wanted:', wantKey);
  console.log('  cart  :', lineKey(got));
  console.log(`total ${(Date.now() - t0) / 1000}s · jev calls so far: ${jevSoFar(st)}`);
  process.exit(2);
}

// Jev applies the merchant coupon on checkout (typed field if present, then a
// bounded Jev pick on the activate control); the quote re-verifies afterwards.
if (MODE === 'jev') {
  const c = await post('/api/apply-coupon', { version: st.state.version });
  lap(`applyCoupon → ${c.ok ? 'applied' : c.code} (jev total: ${jevSoFar(c)})`, c._ms);
  if (c.ok) { st = c; }
  else {
    const rc = await post('/api/reconcile', {}); lap('  reconcile', rc._ms);
    if (rc.ok) st = rc;
  }
}

const q = await post('/api/quote', { version: st.state.version });
lap('quote', q._ms);
if (!q.ok || !q.state?.quote) { console.log('quote failed', q.code); process.exit(1); }
const quote = q.state.quote, a = quote.amounts;
console.log('\n=== VERIFIED QUOTE ===');
console.log(`lines      : ${quote.lines.map(l => `${l.productId}x${l.quantity} @${(l.unitPriceMinor / 100).toFixed(2)}`).join(', ')}`);
console.log(`items      : ${(a.itemSubtotalMinor / 100).toFixed(2)} zl`);
console.log(`packing    : ${(a.serviceFeeMinor / 100).toFixed(2)} zl`);
console.log(`delivery   : ${((a.deliveryFeeMinor ?? 0) / 100).toFixed(2)} zl`);
console.log(`deposits   : ${(a.depositsMinor / 100).toFixed(2)} zl`);
console.log(`discount   : -${(a.discountMinor / 100).toFixed(2)} zl  coupon: ${JSON.stringify(quote.couponResults)}`);
console.log(`TOTAL      : ${(a.merchantTotalMinor / 100).toFixed(2)} zl`);
console.log(`slot       : ${quote.deliverySlot || 'n/a'}  area: ${quote.fulfillmentAreaId}`);
console.log(`stockProof : ${(quote.stockProof?.lines || []).map(l => `${l.productId} ${l.quantity}/${l.availableQuantity}`).join(', ')}`);
console.log('\n=== BENCHMARK ===');
console.log(`rounds     : ${round}`);
console.log(`jev calls  : ${jevSoFar(q)}`);
console.log(`total wall : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
