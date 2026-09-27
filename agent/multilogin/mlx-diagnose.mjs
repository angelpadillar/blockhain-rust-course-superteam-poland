// Read-only Multilogin API diagnosis. It never prints the token or any proxy
// credential. It records the exact status and body of each probe so the 403 can
// be classified precisely.
import { readFileSync } from 'node:fs';

const token = readFileSync('/data/automation-token', 'utf8').trim();
const sanitize = text => String(text ?? '').split(token).join('[token]').slice(0, 700);
const cloud = async (path, { method = 'GET', body = undefined } = {}) => {
  const response = await fetch(`https://api.multilogin.com${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let text = '';
  try { text = await response.text(); } catch {}
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { path, method, status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type'),
    server: response.headers.get('server'),
    cfRay: response.headers.get('cf-ray') ? 'present' : null,
    error: parsed?.status ? { error_code: parsed.status.error_code, message: parsed.status.message,
      http_code: parsed.status.http_code } : null,
    bodyShape: parsed ? Object.keys(parsed).slice(0, 6) : 'non-json',
    bodyPreview: parsed ? null : sanitize(text),
  };
};

const results = [];
// 1. Read endpoint that is known to work today.
results.push(await cloud('/workspace/folders'));
// 2. The failing endpoint, exactly as premiumProxy() calls it.
results.push(await cloud('/proxynm/connection_url?country=pl&protocol=socks5&session_type=sticky&count=1'));
// 3. Variants to separate endpoint/API-change from entitlement.
results.push(await cloud('/proxynm/connection_url'));
results.push(await cloud('/proxy/connection_url?country=pl&protocol=socks5&session_type=sticky&count=1'));
// 4. Another workspace read endpoint and a documented user/plan probe.
results.push(await cloud('/workspace/folders', { method: 'POST', body: {} }));
results.push(await cloud('/user/plan'));
results.push(await cloud('/user/subscription'));
// 5. Profile metadata read (proxy attachment) for youtube-live-01; no credentials printed.
const meta = await cloud('/profile/metas', { method: 'POST', body: { ids: ['ab6f81fa-36a1-4808-b643-2e6268b3f77f'] } });
if (meta.status === 200) {
  const response = await fetch('https://api.multilogin.com/profile/metas', { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['ab6f81fa-36a1-4808-b643-2e6268b3f77f'] }) });
  const payload = await response.json();
  const profile = payload?.data?.profiles?.[0];
  meta.proxyAttachment = profile ? {
    hasProxy: Boolean(profile.parameters?.proxy),
    proxyType: profile.parameters?.proxy?.type ?? null,
    proxyPort: profile.parameters?.proxy?.port ?? null,
    proxyMasking: profile.parameters?.flags?.proxy_masking ?? null,
    inUseBy: profile.in_use_by || null,
  } : null;
}
results.push(meta);

for (const item of results) console.log(JSON.stringify(item));
