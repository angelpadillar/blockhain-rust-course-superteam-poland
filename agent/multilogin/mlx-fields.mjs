// Read-only inspection of one profile's metadata: every top-level and
// parameters/flags key, plus any note/tag-like fields. Proxy credential values
// are never printed.
import { readFileSync } from 'node:fs';

const token = readFileSync('/data/automation-token', 'utf8').trim();
const response = await fetch('https://api.multilogin.com/profile/metas', {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ ids: ['ab6f81fa-36a1-4808-b643-2e6268b3f77f'] }),
});
const payload = await response.json();
const profile = payload?.data?.profiles?.[0];
if (!profile) { console.log(JSON.stringify({ error: 'no profile' })); process.exit(0); }
const shallow = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(item => shallow(item, depth + 1));
  if (typeof value === 'object') {
    if (depth > 1) return `[object:${Object.keys(value).length}]`;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/password|username|user|pass/i.test(key) && typeof item === 'string') return [key, '[redacted]'];
      return [key, shallow(item, depth + 1)];
    }));
  }
  return value;
};
const noteLike = Object.fromEntries(Object.entries(profile).filter(([key]) =>
  /note|tag|label|comment|descri/i.test(key)));
const parameterKeys = Object.keys(profile.parameters || {});
const flagKeys = Object.keys(profile.parameters?.flags || {});
console.log(JSON.stringify({
  topLevelKeys: Object.keys(profile).sort(),
  noteLike,
  name: profile.name,
  hasName: typeof profile.name === 'string',
  parameterKeys: parameterKeys.sort(),
  flagKeys: flagKeys.sort(),
  proxyShape: profile.parameters?.proxy ? {
    type: profile.parameters.proxy.type,
    port: profile.parameters.proxy.port,
    hostShape: 'present',
  } : null,
  metaKeys: profile.meta ? Object.keys(profile.meta).sort() : null,
  shallow: shallow(profile),
}, null, 1).slice(0, 4000));
