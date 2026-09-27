import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockMedia, createBandwidthMeter, mediaUrlPatterns } from '../src/bandwidth.mjs';

test('only media-like resources are selected for blocking', () => {
  assert.equal(shouldBlockMedia({ resourceType: 'media', url: 'https://x/' }), true);
  assert.equal(shouldBlockMedia({ url: 'https://r1---sn-x.googlevideo.com/videoplayback?x=1' }), true);
  assert.equal(shouldBlockMedia({ url: 'https://www.youtube.com/media/videoplayback.mp4' }), true);
  assert.equal(shouldBlockMedia({ url: 'https://x/stream.webm' }), true);
  assert.equal(shouldBlockMedia({ url: 'https://x/live.m3u8' }), true);
  // Auth, document, script and XHR traffic is never touched.
  for (const url of ['https://accounts.google.com/ServiceLogin', 'https://www.youtube.com/',
    'https://www.youtube.com/s/desktop/x.js', 'https://studio.youtube.com/youtubei/v1/x',
    'https://accounts.google.com/o/oauth2/iframe']) {
    assert.equal(shouldBlockMedia({ url, resourceType: 'script' }), false, url);
  }
  assert.equal(mediaUrlPatterns.includes('**/*videoplayback*'), true);
});

function fakeCdp() {
  const listeners = new Map();
  return { sent: [],
    async send(command) { this.sent.push(command); },
    on(event, handler) { listeners.set(event, handler); },
    emit(event, payload) { return listeners.get(event)?.(payload); },
    listeners };
}

test('the meter sums encoded bytes per resource type', async () => {
  const client = fakeCdp();
  const page = { context: () => ({ newCDPSession: async () => client }) };
  const meter = createBandwidthMeter({ blockMedia: true });
  assert.equal(await meter.attach({ page }), true);
  assert.deepEqual(client.sent, ['Network.enable', 'Network.setBlockedURLs'],
    'media is blocked natively, not by intercepting every request');
  client.emit('Network.requestWillBeSent', { requestId: '1', type: 'Document' });
  client.emit('Network.requestWillBeSent', { requestId: '2', type: 'Script' });
  client.emit('Network.loadingFinished', { requestId: '1', encodedDataLength: 1024 });
  client.emit('Network.loadingFinished', { requestId: '2', encodedDataLength: 2048 });
  client.emit('Network.loadingFinished', { requestId: '3', encodedDataLength: 512 });
  client.emit('Network.loadingFailed', { requestId: '4', blockedReason: 'inspector' });
  const summary = meter.summary();
  assert.equal(summary.totalBytes, 3584);
  assert.equal(summary.byType.Document, 1024);
  assert.equal(summary.byType.Script, 2048);
  assert.equal(summary.byType.Other, 512);
  assert.equal(summary.mb, 0.003);
  assert.equal(summary.available, true);
  assert.equal(summary.nativeBlocking, true);
  assert.equal(summary.blockedMedia, 1, 'a blocked media request is counted without bytes');
});

test('media routes abort video and continue everything else', async () => {
  const handlers = [];
  const context = { route: async (pattern, handler) => handlers.push({ pattern, handler }) };
  const meter = createBandwidthMeter({ blockMedia: true });
  await meter.blockMediaRoutes({ context });
  assert.equal(handlers.length, mediaUrlPatterns.length);
  const aborted = []; const continued = [];
  const route = url => ({ request: () => ({ url: () => url,
    resourceType: () => (url.includes('googlevideo') ? 'media' : 'xhr') }),
    abort: async () => aborted.push(url), continue: async () => continued.push(url) });
  await handlers[0].handler(route('https://r1.googlevideo.com/videoplayback?x=1'));
  await handlers[0].handler(route('https://accounts.google.com/xhr'));
  assert.deepEqual(aborted, ['https://r1.googlevideo.com/videoplayback?x=1']);
  assert.deepEqual(continued, ['https://accounts.google.com/xhr']);
  assert.equal(meter.diagnostics.blockedMedia, 1);
});

test('media blocking can be disabled, and a missing CDP session degrades safely', async () => {
  const context = { route: async () => { throw new Error('routing unsupported'); } };
  const meter = createBandwidthMeter({ blockMedia: false });
  await meter.blockMediaRoutes({ context });
  assert.equal(meter.diagnostics.blockedMedia, 0);
  const noCdp = createBandwidthMeter({ blockMedia: true });
  assert.equal(await noCdp.attach({ page: {} }), false);
  assert.equal(noCdp.diagnostics.attachFailures, 1);
  assert.equal(noCdp.summary().available, false);
});
