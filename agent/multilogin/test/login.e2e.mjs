import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadPlaywright } from '../src/runner.mjs';
import { runLogin, LoginBrowser, verifyIdentity, sites } from '../src/login.mjs';
import { parseAccounts, totp } from '../src/core.mjs';
import { createGuide } from '../src/jev.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
async function fixture(t, { wrongPassword = false, requireEmail = false, emailEscape = false, identity = 'fixture_user', delayedControls = false, submitDelayMs = 0, asyncTransition = false } = {}) {
  const posts = []; let authenticated = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const data = new URLSearchParams(body);
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/login' && request.method === 'POST') {
      posts.push('password');
      if (submitDelayMs) await new Promise(resolve => setTimeout(resolve, submitDelayMs));
      if (wrongPassword || data.get('password') !== 'private-password') return response.end('<p>Incorrect password</p>');
      return response.end(requireEmail ? '<p>We sent a code to your email</p>'
        : emailEscape ? '<p>We sent a code to your email</p><input type="tel" aria-label="Enter code"><a href="/totp-page">Try another way</a>'
        : '<p>Enter the code from your authenticator app</p><form action="/verify" method="post"><input name="verificationCode" autocomplete="one-time-code" aria-label="Login code"><button>Confirm</button></form>');
    }
    if (request.url === '/totp-page') {
      return response.end('<p>Enter the code from your authenticator app</p><form action="/verify" method="post"><input name="verificationCode" autocomplete="one-time-code" aria-label="Login code"><button>Confirm</button></form>');
    }
    if (request.url === '/verify' && request.method === 'POST') {
      posts.push('totp');
      if (data.get('verificationCode') !== totp(secret).code) return response.end('<p>Incorrect code</p>');
      authenticated = true; response.setHeader('Set-Cookie', 'fixture_session=yes; HttpOnly; SameSite=Lax');
      response.writeHead(302, { Location: '/' }); return response.end();
    }
    if (request.url === '/' && authenticated && request.headers.cookie?.includes('fixture_session=yes')) {
      return response.end(`<nav><a href="/${identity}/">Profile</a><a href="/direct/inbox/">Messages</a></nav><p>Account home</p>`);
    }
    const form = '<form action="/login" method="post"><input name="username" aria-label="Username"><input type="password" name="password" aria-label="Password"><button>Log in</button></form>';
    const script = asyncTransition ? `<script>document.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const body = new URLSearchParams(new FormData(event.target));
      history.pushState({}, '', '/login/wait');
      document.querySelectorAll('input').forEach(input => input.readOnly = true);
      document.querySelector('button').setAttribute('aria-disabled', 'true');
      const response = await fetch('/login', { method: 'POST', body });
      document.body.innerHTML = await response.text();
    };</script>` : '';
    response.end(delayedControls ? `<p>Log into Instagram</p><script>setTimeout(() => { document.body.innerHTML = ${JSON.stringify(form)}; }, 750)</script>` : form + script);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); const page = await context.newPage();
  const account = parseAccounts(`fixture_user;private-password;${secret}`, 'instagram')[0];
  const requests = [];
  // Deterministic offline test double. These tests do not call Jev or Multilogin.
  const choose = async request => { requests.push(request); return { action: request.actions[0], confidence: 1, probability: 1 }; };
  return { page, context, account, choose, requests, posts,
    site: { loginUrl: `${origin}/login`, homeUrl: `${origin}/`, origins: [origin], credentialOrigins: [origin] } };
}
test('real browser completes username/password/TOTP, verifies identity and reuses session without another submission', async t => {
  const input = await fixture(t);
  assert.equal((await runLogin(input)).verified, true);
  assert.equal((await runLogin({ ...input, verifyOnly: true })).verified, true);
  assert.deepEqual(input.posts, ['password', 'totp']);
  const serialized = JSON.stringify(input.requests);
  assert.equal(serialized.includes('private-password'), false); assert.equal(serialized.includes(secret), false);
});
test('wrong password ends the browser test after one submission', async t => {
  const input = await fixture(t, { wrongPassword: true });
  await assert.rejects(runLogin(input), /invalid_credentials/); assert.deepEqual(input.posts, ['password']);
});
test('client-rendered controls are awaited without reloading or repeating a submission', async t => {
  const input = await fixture(t, { delayedControls: true });
  assert.equal((await runLogin(input)).verified, true);
  assert.deepEqual(input.posts, ['password', 'totp']);
});
test('a slow authentication response completes without submitting credentials twice', async t => {
  const input = await fixture(t, { submitDelayMs: 11000 });
  assert.equal((await runLogin(input)).verified, true);
  assert.deepEqual(input.posts, ['password', 'totp']);
  assert.equal(input.page.listenerCount('response'), 0);
  assert.equal(input.page.listenerCount('requestfailed'), 0);
});
test('a route change with the old disabled form is not a completed login transition', async t => {
  const input = await fixture(t, { submitDelayMs: 11000, asyncTransition: true });
  const events = [];
  assert.equal((await runLogin({ ...input, onStep: async event => events.push(event) })).verified, true);
  assert.deepEqual(input.posts, ['password', 'totp']);
  assert.equal(events.filter(event => event.action === 'submit_login' && event.state === 'before').length, 2);
});
test('email challenge is reported rather than guessed from the authenticator seed', async t => {
  const input = await fixture(t, { requireEmail: true });
  await assert.rejects(runLogin(input), /email_or_sms_verification_required/); assert.deepEqual(input.posts, ['password']);
});
test('the wrong signed-in identity cannot be reported as successful', async t => {
  const input = await fixture(t, { identity: 'different_user' });
  await assert.rejects(runLogin(input), /unsupported_login_screen/);
});
test('a form changed to another origin is rejected before credential entry', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('form').evaluate(form => { form.action = 'https://example.org/collect'; });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const snapshot = await adapter.observe(); const action = adapter.candidates(snapshot)[0];
  await assert.rejects(adapter.execute(action, snapshot), /unexpected_form_destination/);
  assert.equal(await input.page.locator('input[name=username]').inputValue(), '');
});
test('an authenticator challenge with no supplied seed pauses before submitting a code', async t => {
  const input = await fixture(t); input.account.totp = null;
  await assert.rejects(runLogin(input), /totp_secret_missing/); assert.deepEqual(input.posts, ['password']);
});
test('unknown required fields cannot be submitted by the login adapter', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('form').evaluate(form => { form.innerHTML = '<input name="dateOfBirth" required><button>Continue</button>'; });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  assert.deepEqual(adapter.candidates(await adapter.observe()), []);
});
test('an observed cookie choice is resolved before filling the login form', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.evaluate(() => {
    const button = document.createElement('button'); button.textContent = 'Decline optional cookies';
    button.onclick = () => button.remove(); document.body.append(button);
  });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const before = await adapter.observe(); const actions = adapter.candidates(before);
  assert.deepEqual(actions.map(action => action.kind), ['dismiss_cookies']);
  await adapter.execute(actions[0], before);
  assert.deepEqual(adapter.candidates(await adapter.observe()).map(action => action.kind), ['fill_username']);
  assert.equal(await input.page.locator('input[name=username]').inputValue(), '');
});
test('the recognized login flow completes with no model request', async t => {
  const input = await fixture(t);
  const guide = createGuide({ apiKey: 'offline-test-key', fetchImpl: async () => { throw new Error('unexpected model call'); } });
  assert.equal((await runLogin({ ...input, choose: guide })).verified, true);
  assert.equal(guide.metrics.calls, 0); assert.equal(guide.metrics.exactActions, 5);
  assert.deepEqual(input.posts, ['password', 'totp']);
});
test('google totp screen fills the code field and ignores its decoy password input', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('body').evaluate(body => {
    body.innerHTML = '<p>2-Step Verification</p><p>Get a verification code from the Google Authenticator app</p>'
      + '<input type="password" aria-label="Enter your password">'
      + '<input type="tel" aria-label="Enter code"><input type="checkbox" aria-label="Don’t ask again on this device">'
      + '<button>Next</button><button>Try another way</button>';
  });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const snapshot = await adapter.observe();
  const actions = adapter.candidates(snapshot);
  assert.deepEqual(actions.map(action => action.kind), ['fill_totp']);
  await adapter.execute(actions[0], snapshot);
  assert.match(await input.page.locator('input[type=tel]').inputValue(), /^\d{6}$/);
  assert.equal(await input.page.locator('input[type=password]').inputValue(), '');
  const after = await adapter.observe();
  assert.deepEqual(adapter.candidates(after).map(action => action.kind), ['submit_login']);
});
test('a google challenge selection prefers a direct authenticator option', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('body').evaluate(body => {
    body.innerHTML = '<p>Verify it’s you</p><p>Choose how you want to sign in:</p>'
      + '<div role="listitem" data-challengeid="1">Get a verification code at car•••••••••••••••@hotmail.com</div>'
      + '<div role="listitem" data-challengeid="2">Use another phone or computer to finish signing in</div>'
      + '<div role="listitem" data-challengeid="3">Get a verification code from the Google Authenticator app</div>'
      + '<button>Try another way</button>';
  });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const actions = adapter.candidates(await adapter.observe());
  assert.deepEqual(actions.map(action => action.kind), ['choose_totp']);
});
test('try another way wins over submitting an unfillable code field', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('body').evaluate(body => {
    body.innerHTML = '<p>2-Step Verification</p><p>Get a verification code at car•••••••••••••••@hotmail.com</p>'
      + '<input type="tel" aria-label="Enter code"><button>Next</button><button>Try another way</button>';
  });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const actions = adapter.candidates(await adapter.observe());
  assert.deepEqual(actions.map(action => action.kind), ['try_another_way']);
});
test('an email challenge with an authenticator escape reaches TOTP instead of stopping', async t => {
  const input = await fixture(t, { emailEscape: true });
  assert.equal((await runLogin(input)).verified, true);
  assert.deepEqual(input.posts, ['password', 'totp']);
});
test('youtube account menu control is recognized for identity verification', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('body').evaluate(body => {
    body.innerHTML = '<nav><button aria-label="Account menu"></button></nav>';
  });
  const account = { ...input.account, platform: 'youtube' };
  const adapter = new LoginBrowser(input.page, account, { site: input.site });
  assert.deepEqual(adapter.candidates(await adapter.observe()).map(action => action.kind), ['open_account_menu']);
});
test('youtube identity verifies from account switcher evidence', () => {
  const account = { platform: 'youtube', username: 'sstepney77@gmail.com' };
  const snapshot = { url: 'https://www.youtube.com/', controls: [], challengeFrame: false,
    text: 'Accounts\nShalika Stepney\nSStepney77@gmail.com\nShalika Stepney\n@shalikastepney2305\nNo subscribers\nView all channels\nAdd account\nSign out' };
  assert.equal(verifyIdentity(account, snapshot, sites.youtube), true);
});
test('youtube identity fails without the signed-in email or for another account', () => {
  const account = { platform: 'youtube', username: 'sstepney77@gmail.com' };
  const closed = { url: 'https://www.youtube.com/', controls: [], challengeFrame: false,
    text: 'Shalika Stepney\n@shalikastepney2305\nView your channel\nGoogle Account\nSwitch account\nSign out' };
  assert.equal(verifyIdentity(account, closed, sites.youtube), false);
  const wrong = { ...closed, text: 'Accounts\nOther Person\nsomeone.else@gmail.com\nAdd account\nSign out' };
  assert.equal(verifyIdentity(account, wrong, sites.youtube), false);
});
test('the account menu is reopened a bounded number of times and cannot toggle forever', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  // The click never leaves the menu open, standing in for a re-render that
  // discards the opened dropdown, and identity evidence never appears.
  await input.page.locator('body').evaluate(body => {
    body.innerHTML = '<button id="m">Account menu</button>'
      + '<div>Accounts<br>fixture@example.com<br>Add account<br>Sign out</div>';
    document.getElementById('m').onclick = () => {};
  });
  const account = { ...input.account, platform: 'youtube' };
  const adapter = new LoginBrowser(input.page, account, { site: input.site });

  const first = await adapter.observe();
  assert.deepEqual(adapter.candidates(first).map(action => action.kind), ['open_account_menu']);
  await adapter.execute(adapter.candidates(first)[0], first);

  // The first reopen did not stick, so one more bounded attempt is allowed.
  const second = await adapter.observe();
  assert.deepEqual(adapter.candidates(second).map(action => action.kind), ['open_account_menu']);
  await adapter.execute(adapter.candidates(second)[0], second);
  assert.equal(adapter.menuActionCount, 2);

  // With the bounded attempts used up the menu is no longer offered, so the
  // control cannot drive an open/close loop.
  assert.deepEqual(adapter.candidates(await adapter.observe()), []);
});
test('the executor refuses an action that is not bound to the observation it came from', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  const clock = { value: Date.now() };
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site, now: () => clock.value });
  const snapshot = await adapter.observe();
  const action = adapter.candidates(snapshot)[0];

  assert.equal(snapshot.epoch, snapshot.observation.epoch);
  assert.equal(action.observationEpoch, snapshot.epoch, 'a candidate quotes the epoch it came from');
  assert.equal(action.controlId, 'e0', 'and the id that epoch produced');
  assert.equal(action.expectedControlSignature, action.control.key);
  const binding = { decisionObservation: snapshot.observation };

  await adapter.execute(action, snapshot, binding);
  assert.equal(await input.page.locator('input[name=username]').inputValue(), 'fixture_user');
  await assert.rejects(adapter.execute({ ...action, controlId: 'e9' }, snapshot, binding), /stale_observation/);
  await assert.rejects(adapter.execute({ ...action, observationEpoch: 'not-this-epoch' }, snapshot, binding),
    /stale_observation/);
  await assert.rejects(adapter.execute({ ...action, expectedControlSignature: null }, snapshot, binding),
    /expected_control_signature_required/);
  clock.value += 60000;
  await assert.rejects(adapter.execute({ ...action }, snapshot, binding), /expired_observation/);
});

test('a decision taken on epoch N is not executed against epoch N+1', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const decidedOn = await adapter.observe();
  const decidedAction = adapter.candidates(decidedOn)[0];

  // The page moves on: an unrelated control appears, so it is a new epoch. It is
  // not a login candidate, so the flow would otherwise continue unchanged.
  await input.page.locator('form').evaluate(form => {
    form.insertAdjacentHTML('afterend', '<button type="button">Show more</button>');
  });
  const later = await adapter.observe();
  assert.notEqual(later.epoch, decidedOn.epoch);
  assert.notEqual(later.observation.fingerprint, decidedOn.observation.fingerprint);

  // The earlier decision is bound to the control of the earlier epoch, so it
  // cannot be executed against the page now in front of us.
  await assert.rejects(adapter.execute(decidedAction, later, { decisionObservation: decidedOn.observation }),
    /stale_observation/, 'the earlier decision is not replayed against the newer page');
  assert.equal(await input.page.locator('input[name=username]').inputValue(), '');

  // Re-observing is what execution requires: the fresh decision carries the
  // fresh epoch and succeeds.
  const laterAction = adapter.candidates(later)[0];
  assert.equal(laterAction.observationEpoch, later.epoch);
  await adapter.execute(laterAction, later, { decisionObservation: later.observation });
  assert.equal(await input.page.locator('input[name=username]').inputValue(), 'fixture_user');
});

test('a generic Code field is TOTP only when the page identifies an authenticator app', async t => {
  const input = await fixture(t); await input.page.goto(input.site.loginUrl);
  await input.page.locator('body').evaluate(body => {
    body.innerHTML = '<p>Go to your authentication app</p><input type="text" aria-label="Code"><div role="button" aria-disabled="true">Continue</div>';
  });
  const adapter = new LoginBrowser(input.page, input.account, { site: input.site });
  const snapshot = await adapter.observe();
  assert.deepEqual(adapter.candidates(snapshot).map(action => action.kind), ['fill_totp']);
  await adapter.execute(adapter.candidates(snapshot)[0], snapshot);
  assert.match(await input.page.locator('input').inputValue(), /^\d{6}$/);
  assert.equal(adapter.candidates(await adapter.observe()).length, 0);
  await input.page.locator('p').evaluate(element => { element.textContent = 'Enter the code sent to your email'; });
  const emailAdapter = new LoginBrowser(input.page, input.account, { site: input.site });
  assert.equal(emailAdapter.candidates(await emailAdapter.observe()).length, 0);
});
