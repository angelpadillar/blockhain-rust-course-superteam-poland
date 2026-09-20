import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const config = { adapter: 'glovo', storeUrl: 'https://glovoapp.com/pl/pl/krakow/stores/test-shop',
  merchant: 'Test shop', destinationLabel: 'Test venue', expectedAddress: 'Test Street 20', privateValues: [],
  maxPln: 26, maxSteps: 10, maxRunMs: 20000, maxModelUsd: 0.05, inputUsdPerMillion: 0.042, outputUsdPerMillion: 0, model: 'jev-latest' };
export const job = { items: [{ query: 'Test apple juice 1 L', qty: 1 }], maxPln: 26 };
export function control(label, extra = {}) { return { index: 0, tag: 'button', label, testid: '', href: '',
  value: '', type: '', product: '', context: '', ...extra }; }
export function observation(extra = {}) { return { url: config.storeUrl, controls: [], cart: [], cartKnown: true,
  cartUnits: 0, destinationVerified: true, blocked: false, ...extra }; }
export const checkout = extra => observation({ url: 'https://glovoapp.com/pl/pl/krakow/order-summary', checkoutReady: true,
  checkoutUnits: 1, checkoutMerchant: 'Test shop', totalMinor: 1000, ...extra });
export async function temp(t) { const path = await mkdtemp(join(tmpdir(), 'jev-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
export function response(choice, extra = {}) { return { answers: { next_action: { type: 'choice', choice } },
  usage: { input_tokens: 1000, output_tokens: 10 }, model: 'jev-test', latencyMs: 1, ...extra }; }
