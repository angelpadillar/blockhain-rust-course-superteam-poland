import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { PilotError, requireThat, parseAccounts } from './core.mjs';
import { readPrivate } from './storage.mjs';

// Jobs reference credentials by `accountRef` so logs, reports and summaries
// never need an account handle. The values themselves stay in the existing
// private store: mode-600 files read through readPrivate, validated by
// parseAccounts. Nothing is ever printed.
export const refPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function parsePrivateJson(text) {
  try { return JSON.parse(text); } catch { throw new PilotError('invalid_accounts_json'); }
}
function recordsOf(value) {
  if (Array.isArray(value)) return value;
  requireThat(value && typeof value === 'object', 'invalid_accounts_json');
  return Object.entries(value).map(([ref, record]) => {
    requireThat(record && typeof record === 'object' && !Array.isArray(record), 'invalid_accounts_json');
    return { ...record, ref };
  });
}

export function accountsFromRecords(records) {
  requireThat(Array.isArray(records) && records.length > 0, 'empty_account_import');
  for (const record of records) {
    requireThat(record && typeof record === 'object' && typeof record.ref === 'string'
      && refPattern.test(record.ref), 'invalid_account_ref');
  }
  const accounts = parseAccounts(JSON.stringify(records));
  const index = new Map();
  accounts.forEach((account, position) => {
    requireThat(!index.has(records[position].ref), 'duplicate_account_ref');
    index.set(records[position].ref, account);
  });
  return index;
}

export async function loadAccountIndex({ path, directory } = {}) {
  requireThat(path || directory, 'account_source_required');
  const records = [];
  if (path) records.push(...recordsOf(parsePrivateJson(await readPrivate(resolve(path)))));
  if (directory) {
    const entries = (await readdir(resolve(directory), { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const value = parsePrivateJson(await readPrivate(resolve(directory, entry.name)));
      records.push(...recordsOf(value).map(record => ('ref' in record ? record : { ...record, ref: entry.name.slice(0, -5) })));
    }
  }
  return accountsFromRecords(records);
}

export function selectJobAccounts(index, jobs) {
  const selected = new Map();
  for (const job of jobs) {
    requireThat(index.has(job.accountRef), 'unknown_account_ref');
    selected.set(job.accountRef, index.get(job.accountRef));
  }
  return selected;
}
