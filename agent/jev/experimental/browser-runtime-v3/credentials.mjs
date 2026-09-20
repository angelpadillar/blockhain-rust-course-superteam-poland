import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ProviderError } from './providers.mjs';

// The explicit item reference is supplied by the operator. The secret stays in
// this process, never argv, an environment variable, a browser or a result file.
export async function readOpenRouterItem(item) {
  if (typeof item !== 'string' || !item.trim() || item.length > 250 || /[\x00-\x1f]/.test(item)) throw new ProviderError('invalid_secret_reference');
  let result;
  try {
    result = await promisify(execFile)('op', ['item', 'get', item, '--fields', 'label=credential', '--reveal'],
      { encoding: 'utf8', maxBuffer: 32000, timeout: 120000 });
  } catch { throw new ProviderError('secret_item_unavailable'); }
  const key = result.stdout.trim();
  if (key.length < 20 || key.length > 500 || /\s/.test(key)) throw new ProviderError('invalid_secret_value');
  return key;
}
