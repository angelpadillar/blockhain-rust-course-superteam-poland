import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAccounts, totp, parseTotp, failurePolicy, createRedactor, PilotError, navigationError } from '../src/core.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { createJev, createGuide } from '../src/jev.mjs';
import { classifyPage, verifyIdentity } from '../src/login.mjs';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
test('vendor import preserves quoted semicolons, password whitespace, and stable identity', () => {
  const [account] = parseAccounts(`person_1;" semi;colon ";${seed}`, 'instagram');
  assert.equal(account.password, ' semi;colon ');
  assert.equal(account.id, parseAccounts(`person_1;changed;${seed}`, 'instagram')[0].id);
});
test('invalid or duplicate records stop without echoing their contents', () => {
  assert.throws(() => parseAccounts('user;secret;seed;extra', 'instagram'), /expected_username_password_totp_columns/);
  assert.throws(() => parseAccounts('user;secret;badsecret', 'instagram'), /invalid_totp_secret/);
  assert.throws(() => parseAccounts('user;secret;\nuser;another;', 'instagram'), /duplicate_account/);
  assert.throws(() => parseAccounts('[{"password":"private-value"}'), error => !error.message.includes('private-value'));
});
test('RFC 6238 SHA1 vectors including times after 2038', () => {
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(totp(`otpauth://totp/test?secret=${seed}&digits=8`, seconds * 1000).code, expected);
  }
});
test('TOTP stays local and rejects unrelated URLs and HOTP', () => {
  assert.throws(() => parseTotp('https://2fa.live/some-private-key'), /invalid_totp_secret/);
  assert.throws(() => parseTotp(`otpauth://hotp/test?secret=${seed}`), /unsupported_otp_type/);
  assert.equal(totp(seed, 59000).validForMs, 1000);
});
test('proxy failover applies only to concrete transport failures', () => {
  assert.equal(failurePolicy('proxy_connection_failed').rotateProxy, true);
  for (const reason of ['invalid_credentials', 'rate_limited', 'human_verification_required', 'site_access_denied',
    'page_load_timeout', 'page_did_not_advance', 'invalid_verification_code', 'account_restricted']) {
    assert.equal(failurePolicy(reason).rotateProxy, false, reason);
  }
  assert.equal(navigationError(new Error('net::ERR_PROXY_CONNECTION_FAILED')).code, 'proxy_connection_failed');
});
test('redactor removes credential, email and verification-code material', () => {
  const redact = createRedactor(['private-password', seed]); redact.add('123456');
  assert.equal(redact(`private-password ${seed} alice@example.com 123456`), '[secret] [secret] [email] [secret]');
});
test('page failure classification separates authentication, restrictions and external verification', () => {
  for (const [text, expected] of [['Incorrect password', 'invalid_credentials'], ['Try again later', 'rate_limited'],
    ['We sent a code to your email', 'email_or_sms_verification_required'], ['Verify you are human', 'human_verification_required'],
    ['Couldn’t find this account', 'account_not_found'], ['Could not find your Google account', 'account_not_found']]) {
    assert.equal(classifyPage({ text }), expected);
  }
  assert.equal(classifyPage({ text: 'Enter the code from your authenticator app' }), null);
});
test('a public Instagram profile is insufficient evidence of an authenticated identity', () => {
  const account = { platform: 'instagram', username: 'expected' };
  const snapshot = { url: 'https://www.instagram.com/', text: '', controls: [{ href: 'https://www.instagram.com/expected/' }] };
  assert.equal(verifyIdentity(account, snapshot), false);
  snapshot.controls.push({ href: 'https://www.instagram.com/direct/inbox/' });
  assert.equal(verifyIdentity(account, snapshot), true);
  assert.equal(verifyIdentity({ ...account, username: 'someone_else' }, snapshot), false);
});
test('YouTube verification requires the intended email and an authenticated account menu', () => {
  const account = { platform: 'youtube', username: 'right@example.com' };
  const snapshot = { url: 'https://www.youtube.com/', controls: [], text: 'Google Account right@example.com Sign out Switch account' };
  assert.equal(verifyIdentity(account, snapshot), true);
  snapshot.text += ' wrong@example.com'; assert.equal(verifyIdentity(account, snapshot), false);
});
test('Multilogin requests use verified endpoint shapes and preserve metadata on proxy update', async () => {
  const calls = []; const meta = { id: 'profile-0001', name: 'test', is_auto_update: false,
    parameters: { storage: { is_local: false }, flags: { canvas_noise: 'natural' }, fingerprint: { navigator: { hardware_concurrency: 8 } } } };
  const api = new Multilogin({ token: 'test-token-long-enough', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ data: url.endsWith('/metas') ? { profiles: [meta] }
      : url.includes('/start?') ? { port: '50001', browser_type: 'mimic' } : { ids: ['profile-0001'] } }) };
  } });
  assert.equal(await api.create({ name: 'test', folderId: 'folder-0001', osType: 'linux', cloudStorage: true }), 'profile-0001');
  assert.equal(await api.start('folder-0001', 'profile-0001', true), 50001);
  await api.changeProxy('profile-0001', { host: 'proxy.example', port: 1080, type: 'socks5' });
  const body = JSON.parse(calls.at(-1).options.body);
  assert.equal(body.auto_update_core, false);
  assert.equal(body.parameters.fingerprint.navigator.hardware_concurrency, 8);
  assert.equal(body.parameters.flags.canvas_noise, 'natural');
  assert.equal(body.parameters.flags.proxy_masking, 'custom');
  assert.ok(calls[1].url.includes('automation_type=playwright'));
  assert.equal(calls[0].options.redirect, 'error');
});
test('premium proxy API requests a sticky session and returns credentials only to the caller', async () => {
  let called;
  const api = new Multilogin({ token: 'test-token-long-enough', fetchImpl: async url => {
    called = url; return { ok: true, json: async () => ({ data: { connection_urls: ['gate.example:1080:user-session:private'] } }) };
  } });
  const proxy = await api.premiumProxy('pl');
  assert.ok(called.includes('country=pl&protocol=socks5&session_type=sticky'));
  assert.equal(proxy.username, 'user-session');
});
test('API failures never expose response bodies or authorization', async () => {
  const api = new Multilogin({ token: 'private-token-value', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'private-token-value' }) });
  await assert.rejects(api.folders(), error => error.message === 'multilogin_http_401');
});
test('launcher proxy failure is recoverable only after its profile status confirms validation failed', async () => {
  for (const status of ['validate_proxy_error', 'browser_running']) {
    const api = new Multilogin({ token: 'private-test-token', fetchImpl: async url => url.includes('/start?')
      ? { ok: false, status: 400, json: async () => ({ status: { error_code: 'WRONG_PROXY', message: 'private-proxy-password' } }) }
      : { ok: true, json: async () => ({ data: { status } }) } });
    await assert.rejects(api.start('folder-0001', 'profile-0001', true), error => {
      assert.equal(error.message.includes('private-proxy-password'), false);
      return status === 'validate_proxy_error'
        ? error.code === 'proxy_connection_failed' && error.lifecycleStopped === true
        : error.code === 'multilogin_http_400' && error.lifecycleStopped === undefined;
    });
  }
});
test('only the documented already-stopped error is accepted as a successful stop', async () => {
  for (const message of ['profile already stopped', 'database is unavailable']) {
    const api = new Multilogin({ token: 'private-test-token', fetchImpl: async () => ({ ok: false, status: 500,
      json: async () => ({ status: { error_code: 'INTERNAL_SERVER_ERROR', message } }) }) });
    if (message === 'profile already stopped') assert.equal((await api.stop('profile-0001')).alreadyStopped, true);
    else await assert.rejects(api.stop('profile-0001'), /multilogin_http_500/);
  }
});
test('Jev can select only observed actions and unknown billing is retained', async () => {
  const choose = createJev({ apiKey: 'test-typesafe-key', fetchImpl: async () => ({ ok: true,
    json: async () => ({ answers: { action: { type: 'choice', choice: 'a999', confidence: 1, probabilities: { a999: 1 } } } }) }) });
  await assert.rejects(choose({ page: {}, actions: [{ id: 'a0', description: 'Fill supplied username' }] }), /jev_unknown_action/);
  assert.equal(choose.metrics.usageComplete, false);
});
test('the current editor choice contract rejects malformed distributions and unknown usage', async () => {
  for (const [probabilities, usage, expected] of [
    [{ a0: 1, stop: 1 }, { input_tokens: 1, output_tokens: 1 }, 'jev_invalid_probabilities'],
    [{ a0: 0.3, stop: 0.7 }, { input_tokens: 1, output_tokens: 1 }, 'jev_invalid_probabilities'],
    [{ a0: 1, stop: 0 }, undefined, 'jev_usage_unknown'],
  ]) {
    const choose = createJev({ apiKey: 'test-typesafe-key', fetchImpl: async () => ({ ok: true, json: async () => ({
      answers: { action: { type: 'choice', choice: 'a0', confidence: 1, probabilities } }, usage,
    }) }) });
    await assert.rejects(choose({ page: {}, actions: [{ id: 'a0', description: 'Fill username' }] }), new RegExp(expected));
  }
});
test('one permitted observed action uses no Jev API call', async () => {
  const choose = createGuide({ apiKey: 'test-typesafe-key', fetchImpl: async () => { throw new Error('must not call'); } });
  const result = await choose({ page: {}, actions: [{ id: 'a0', description: 'Fill username' }] });
  assert.equal(result.method, 'exact-single-match'); assert.equal(choose.metrics.calls, 0); assert.equal(choose.metrics.exactActions, 1);
});
