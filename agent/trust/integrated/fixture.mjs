import { randomUUID } from 'node:crypto';

export const RECIPIENT = Object.freeze({ name: 'Marta', commitmentId: 'fictional-marta-demo', brief: 'Fictional demo brief: Marta enjoys pour-over coffee, trying independent roasters and weekend cycling. Avoid alcohol.' });
export const ITEM = Object.freeze({ id: 'coffee-discovery-3x100g', title: 'Weekend Coffee Discovery Set', variant: 'Three 100 g whole-bean coffees', quantity: 1, unitPriceMinor: 12900 });
export const MERCHANT = Object.freeze({ id: 'krakow-coffee-lab-demo', name: 'Kraków Coffee Lab — demo' });
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const money = value => `${(value / 100).toFixed(2)} PLN`;
export const sameQuote = (a, b) => Boolean(a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]));

// Separate fixture ledger is the merchant's source of truth. The executor
// cannot declare success by returning its own request as a receipt.
export class MerchantFixture {
  constructor(runId, scenario) { this.runId = runId; this.scenario = scenario; this.totalMinor = 12900; this.orders = new Map(); this.permit = null; this.dispatchCount = 0; }
  quote() { return { merchantId: MERCHANT.id, merchant: MERCHANT.name, itemId: ITEM.id, item: ITEM.title, variant: ITEM.variant,
    quantity: 1, recipientId: RECIPIENT.commitmentId, recipient: RECIPIENT.name, totalMinor: this.totalMinor, currency: 'PLN' }; }
  permitAttempt(attemptId, expected) {
    if (this.permit || this.orders.size || !sameQuote(this.quote(), expected)) throw new Error('fixture_permit_refused');
    this.permit = { attemptId, expected: structuredClone(expected) };
  }
  submit(attemptId) {
    if (!this.permit || this.permit.attemptId !== attemptId) throw new Error('confirmed_chain_permit_required');
    const permit = this.permit; this.permit = null;
    if (!sameQuote(this.quote(), permit.expected)) throw new Error('checkout_changed_before_dispatch');
    this.dispatchCount++;
    const order = { ...this.quote(), orderId: 'demo-' + randomUUID(), attemptId, status: 'fulfilled_simulation', createdAt: new Date().toISOString() };
    this.orders.set(order.orderId, order);
    return { order, responseLost: this.scenario === 'uncertain' };
  }
  byAttempt(attemptId) { return [...this.orders.values()].find(order => order.attemptId === attemptId) || null; }
  render(order = null) {
    const q = order || this.quote();
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${order ? 'Simulated order confirmation' : 'Gift checkout'} · Buena sandbox</title>
    <style>body{font:18px system-ui;background:#f7f3ed;color:#202e26;margin:0;padding:70px}main{max-width:750px;margin:auto;background:white;padding:40px;border-radius:20px}small{color:#735b36}h1{font-size:34px}dl{display:grid;grid-template-columns:180px 1fr;gap:18px}dd{margin:0}button{padding:15px;border:0;background:#20553e;color:white;border-radius:8px;font:inherit}strong{font-size:30px}</style>
    <main><small>SIMULATED MERCHANT · NO CARD CHARGE OR PHYSICAL DELIVERY</small><h1>${escapeHtml(q.item)}</h1><p data-field="variant">${escapeHtml(q.variant)}</p><dl>
    ${[['merchantId', q.merchantId], ['merchant', q.merchant], ['itemId', q.itemId], ['quantity', q.quantity], ['recipientId', q.recipientId], ['recipient', q.recipient], ['currency', q.currency], ['totalMinor', q.totalMinor]].map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd data-field="${key}">${escapeHtml(value)}</dd>`).join('')}
    <dt>Total</dt><dd><strong>${money(q.totalMinor)}</strong></dd></dl><span data-field="item">${escapeHtml(q.item)}</span>
    ${order ? `<h2>Fulfillment simulated</h2><p data-field="orderId">${escapeHtml(order.orderId)}</p><p data-field="attemptId">${escapeHtml(order.attemptId)}</p><p data-field="status">${escapeHtml(order.status)}</p>` : `<form method="POST" action="/merchant/${this.runId}/order"><input name="attemptId" aria-label="Confirmed attempt reference" required><button>Place simulated order</button></form>`}
    </main></html>`;
  }
}

export function verifyOrder({ expected, attemptId, observed, ledgerOrder }) {
  const checks = Object.keys(expected).map(key => ({ label: key, expected: expected[key], actual: observed?.[key], passed: observed?.[key] === expected[key] && ledgerOrder?.[key] === expected[key] }));
  checks.push({ label: 'one matching merchant order', expected: attemptId, actual: ledgerOrder?.attemptId, passed: Boolean(ledgerOrder && observed?.orderId === ledgerOrder.orderId && observed?.attemptId === attemptId && ledgerOrder.attemptId === attemptId) });
  checks.push({ label: 'fixture fulfillment recorded', expected: 'fulfilled_simulation', actual: ledgerOrder?.status, passed: ledgerOrder?.status === 'fulfilled_simulation' && observed?.status === 'fulfilled_simulation' });
  return { ok: checks.every(check => check.passed), checks, source: 'Merchant DOM plus separate fixture order ledger; no real delivery attestation' };
}
