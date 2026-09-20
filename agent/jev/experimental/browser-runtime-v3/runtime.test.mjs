import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedUrl, allowedRequest, deniedText, normalize } from './browser.mjs';
import { validateTask } from './runtime.mjs';

test('task contract accepts only goal-derived text and never an expected URL or identifier', () => {
  assert.deepEqual(validateTask({ query: ' Lantern ', targetText: 'Lantern', context: 'Studio shelf' }),
    { query: 'Lantern', targetText: 'Lantern', context: 'Studio shelf' });
  for (const extra of ['targetUrl', 'expectedUrl', 'productId', 'selector', 'script']) {
    assert.throws(() => validateTask({ query: 'Lantern', targetText: 'Lantern', [extra]: 'forbidden' }), /unsupported_task/);
  }
  for (const query of ['', 'bad\nquery', null, 'a'.repeat(241)]) assert.throws(() => validateTask({ query, targetText: 'Lantern' }), /invalid_task/);
});

test('passive CDN resources do not expand navigation, fetch or mutation permission', () => {
  const origin = 'https://fixture.test';
  const resource = { url: 'https://cdn.test/asset.css', method: 'GET', navigation: false, resourceType: 'stylesheet' };
  assert.equal(allowedRequest(resource, origin), true);
  for (const override of [{ navigation: true }, { method: 'POST' }, { resourceType: 'fetch' }, { resourceType: 'xhr' },
    { resourceType: 'document' }, { url: 'data:text/css,test' }, { url: 'https://user:secret@cdn.test/asset.css' }]) {
    assert.equal(allowedRequest({ ...resource, ...override }, origin), false);
  }
  assert.equal(allowedRequest({ ...resource, url: origin + '/account/settings' }, origin), false);
});

test('navigation URL policy accepts same-origin reads and rejects destructive scope and alternative schemes', () => {
  const origin = 'https://fixture.test';
  for (const path of ['/search?q=payment+history', '/items/123', '/wiki/Navigation']) assert.equal(allowedUrl(origin + path, origin), true);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://other.test/items/1', 'http://fixture.test/items/1',
    'https://user:password@fixture.test/items/1', ...['cart', 'orders', 'payment', 'account', 'profile', 'address', 'addresses', 'login', 'delete'].map(x => `${origin}/${x}/1`),
    `${origin}/items/1?action=delete`]) assert.equal(allowedUrl(url, origin), false);
  assert.equal(deniedText('Open account settings'), true);
  assert.equal(deniedText('Lantern'), false);
  assert.equal(normalize('  LANTERN\u00a0 lamp  '), 'lantern lamp');
});
