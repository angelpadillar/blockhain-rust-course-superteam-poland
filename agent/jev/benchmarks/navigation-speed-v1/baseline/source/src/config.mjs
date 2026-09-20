import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const normalize = value => String(value).normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pl');
export class Stop extends Error { constructor(code) { super(code); this.code = code; } }
export function assert(condition, code) { if (!condition) throw new Stop(code); }
const finite = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;

export function validateConfig(raw) {
  assert(raw && raw.adapter === 'glovo', 'unsupported_adapter');
  const u = new URL(raw.storeUrl);
  assert(u.protocol === 'https:' && u.hostname === 'glovoapp.com' && !u.port && !u.username && !u.password
    && /^\/(?:pl\/(?:pl|en)|en\/pl)\/krakow\/stores\/[a-z0-9-]+\/?$/.test(u.pathname)
    && !u.search && !u.hash, 'invalid_store_url');
  for (const key of ['merchant', 'destinationLabel', 'expectedAddress']) {
    assert(typeof raw[key] === 'string' && raw[key].trim().length >= 3 && raw[key].length <= 200, `invalid_${key}`);
  }
  assert(!raw.expectedAddress.includes('REPLACE'), 'configure_destination_first');
  assert(Array.isArray(raw.privateValues) && raw.privateValues.every(v => typeof v === 'string' && v.length >= 3), 'invalid_private_values');
  if (raw.expectedAccountLabel !== undefined) {
    assert(typeof raw.expectedAccountLabel === 'string' && raw.expectedAccountLabel.trim().length > 0
      && raw.expectedAccountLabel.length <= 100, 'invalid_account_label');
  }
  assert(finite(raw.maxPln, 1, 1000), 'invalid_budget');
  assert(Number.isInteger(raw.maxSteps) && finite(raw.maxSteps, 1, 60), 'invalid_step_limit');
  assert(finite(raw.maxRunMs, 5000, 600000), 'invalid_time_limit');
  assert(finite(raw.maxModelUsd, 0.0001, 1), 'invalid_model_budget');
  assert(finite(raw.inputUsdPerMillion, 0, 100) && finite(raw.outputUsdPerMillion, 0, 100), 'invalid_pricing');
  assert(/^jev-[a-zA-Z0-9.-]+$/.test(raw.model), 'invalid_model');
  return Object.freeze({ ...raw });
}

export function validateJob(raw, config) {
  assert(raw && typeof raw === 'object' && !Array.isArray(raw), 'invalid_job');
  assert(Object.keys(raw).every(k => ['items', 'maxPln'].includes(k)), 'unsupported_job_field');
  assert(Array.isArray(raw.items) && raw.items.length > 0 && raw.items.length <= 5, 'invalid_items');
  const items = raw.items.map(item => {
    assert(item && Object.keys(item).every(k => ['query', 'qty'].includes(k)), 'invalid_item');
    assert(typeof item.query === 'string' && item.query.trim().length >= 3 && item.query.length <= 200
      && !/[\r\n\x00-\x1f]/.test(item.query), 'invalid_query');
    assert(Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 5, 'invalid_quantity');
    return { query: item.query.trim(), qty: item.qty };
  });
  assert(new Set(items.map(i => normalize(i.query))).size === items.length, 'duplicate_item');
  assert(finite(raw.maxPln, 1, config.maxPln), 'budget_exceeds_policy');
  return { items, maxPln: raw.maxPln };
}

export async function loadSettings() {
  const configPath = resolve(process.env.JEV_CONFIG || 'config.local.json');
  const config = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
  return { config, dataDir: resolve(process.env.JEV_DATA_DIR || 'data'),
    token: process.env.JEV_SERVICE_TOKEN, apiKey: process.env.TYPESAFE_API_KEY,
    host: process.env.JEV_HOST || '127.0.0.1', port: Number(process.env.JEV_PORT || 8787) };
}
