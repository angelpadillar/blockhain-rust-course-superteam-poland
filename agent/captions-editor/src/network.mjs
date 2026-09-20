// Never expose paths, signed queries, headers, bodies, login links, or raw errors.
export function networkSummary(payload) {
  const groups = new Map();
  for (const event of Array.isArray(payload?.requests) ? payload.requests : []) {
    let hostname; try { hostname = new URL(event.url).hostname; } catch { continue; }
    if (!/^[a-z0-9.-]{1,253}$/i.test(hostname)) continue;
    const kind = ['request', 'response', 'request_failed'].includes(event.event) ? event.event : 'unknown';
    const status = Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : null;
    const key = JSON.stringify([hostname, kind, status]);
    const item = groups.get(key) || { hostname, event: kind, status, count: 0 };
    item.count++; groups.set(key, item);
  }
  return { hosts: [...groups.values()], dropped: Number.isSafeInteger(payload?.dropped) ? payload.dropped : null, note: 'Host-only diagnostics; failed requests do not by themselves prove an allowlist rejection.' };
}
