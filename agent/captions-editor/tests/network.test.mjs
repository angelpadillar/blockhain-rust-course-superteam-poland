import test from 'node:test';
import assert from 'node:assert/strict';
import { networkSummary } from '../src/network.mjs';
test('network evidence contains hostnames and statuses but no account or signed URL data', () => {
  const report = networkSummary({ requests: [{ event: 'request_failed', url: 'https://uploads.example.com/private-user/asset?token=secret', headers: { Authorization: 'secret' } }, { event: 'response', status: 403, url: 'https://uploads.example.com/other?key=secret' }], dropped: 2 });
  assert.equal(report.hosts[0].hostname, 'uploads.example.com'); assert.equal(report.hosts[1].status, 403); assert.equal(report.dropped, 2);
  assert(!/secret|private-user|Authorization/.test(JSON.stringify(report)));
});
