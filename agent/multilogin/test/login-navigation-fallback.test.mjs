import test from 'node:test';
import assert from 'node:assert/strict';
import { clickWithNavigationFallback, dedupeLinkActions, navigationFallbackKinds } from '../src/login.mjs';

const site = {
  origins: ['https://www.youtube.com'],
  credentialOrigins: ['https://www.youtube.com', 'https://accounts.google.com'],
};

function fakeControl({ failWith = null } = {}) {
  const calls = [];
  return { calls, handle: { click: async options => { calls.push(options); if (failWith) throw failWith; } } };
}

test('a normal click is used when the control is actionable', async () => {
  const control = fakeControl();
  const navigations = [];
  const result = await clickWithNavigationFallback({ kind: 'submit_login', control, current: { href: '' }, site,
    page: { goto: async url => navigations.push(url) } });
  assert.equal(result.method, 'click');
  assert.equal(navigations.length, 0);
  assert.ok(control.calls[0].timeout >= 8000, 'a verified submit gets actionability headroom');
});

test('reversible navigation links get more actionability headroom', async () => {
  const control = fakeControl();
  await clickWithNavigationFallback({ kind: 'open_login', control, current: { href: '' }, site,
    page: { goto: async () => {} } });
  assert.equal(navigationFallbackKinds.has('open_login'), true);
  assert.equal(control.calls[0].timeout >= 8000, true);
});

test('a covered sign-in link falls back to its own allowed href', async () => {
  const control = fakeControl({ failWith: new Error('TimeoutError: element is not clickable') });
  const navigations = [];
  const result = await clickWithNavigationFallback({ kind: 'open_login', control,
    current: { href: 'https://accounts.google.com/ServiceLogin?service=youtube' }, site,
    page: { goto: async (url, options) => navigations.push({ url, options }) } });
  assert.equal(result.method, 'href_navigation');
  assert.equal(result.hrefOrigin, 'https://accounts.google.com');
  assert.equal(navigations.length, 1);
  assert.match(navigations[0].url, /^https:\/\/accounts\.google\.com\/ServiceLogin/);
});

test('the fallback refuses any origin the site does not already allow', async () => {
  const control = fakeControl({ failWith: new Error('TimeoutError') });
  let navigated = false;
  await assert.rejects(() => clickWithNavigationFallback({ kind: 'open_login', control,
    current: { href: 'https://evil.example/login' }, site,
    page: { goto: async () => { navigated = true; } } }), /TimeoutError/);
  assert.equal(navigated, false);
});

test('a blocked Next click falls back to a keyboard submit', async () => {
  const control = { handle: {
    click: async () => { throw new Error('TimeoutError: button is covered by an overlay'); },
    focus: async () => {},
  } };
  const keys = [];
  const result = await clickWithNavigationFallback({ kind: 'submit_login', control,
    current: { href: '' }, site,
    page: { keyboard: { press: async key => keys.push(key) }, goto: async () => {} } });
  assert.equal(result.method, 'keyboard_submit');
  assert.deepEqual(keys, ['Enter']);
});

test('a broken keyboard submit still surfaces the original click error', async () => {
  const control = { handle: {
    click: async () => { throw new Error('TimeoutError: covered'); },
    focus: async () => { throw new Error('not focusable'); },
  } };
  await assert.rejects(() => clickWithNavigationFallback({ kind: 'submit_login', control,
    current: { href: '' }, site, page: { keyboard: { press: async () => {} }, goto: async () => {} } }), /TimeoutError/);
});

test('non-navigation kinds never take the fallback', async () => {
  const control = fakeControl({ failWith: new Error('TimeoutError') });
  let navigated = false;
  await assert.rejects(() => clickWithNavigationFallback({ kind: 'click_observed', control,
    current: { href: 'https://accounts.google.com/ServiceLogin' }, site,
    page: { goto: async () => { navigated = true; } } }), /TimeoutError/);
  assert.equal(navigated, false);
});

test('identical link destinations collapse to one deterministic candidate', () => {
  const actions = [
    { kind: 'open_login', control: { href: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=a' } },
    { kind: 'open_login', control: { href: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=b' } },
    { kind: 'dismiss_cookies', control: { href: '' } },
    { kind: 'dismiss_cookies', control: { href: '' } },
  ];
  const deduped = dedupeLinkActions(actions);
  assert.equal(deduped.length, 3);
  assert.equal(deduped.filter(action => action.kind === 'open_login').length, 1);
  assert.equal(deduped.filter(action => action.kind === 'dismiss_cookies').length, 2);
});

test('different destinations or kinds are not collapsed', () => {
  const actions = [
    { kind: 'open_login', control: { href: 'https://accounts.google.com/ServiceLogin' } },
    { kind: 'try_another_way', control: { href: 'https://accounts.google.com/ServiceLogin' } },
    { kind: 'open_login', control: { href: 'https://accounts.google.com/v3/signin/challenge' } },
  ];
  assert.equal(dedupeLinkActions(actions).length, 3);
});
