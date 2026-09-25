import { createServer } from 'node:http';
import { accountsFromRecords } from '../../src/accounts.mjs';
import { totp } from '../../src/core.mjs';
import { loadPlaywright } from '../../src/runner.mjs';
import { sites } from '../../src/login.mjs';

// Offline stand-in for the whole live stack: a local provider service, a real
// headless browser in per-profile contexts, a Multilogin API stub and a
// deterministic chooser. It creates no accounts, makes no network calls and
// spends no provider budget. The login, recovery, checkpoint, Studio and
// restart-persistence code paths are the real ones.
export const fixtureSeed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
export const fixturePassword = 'private-password';
export const fixtureUsername = 'fixture.account@gmail.com';
export const challengedUsername = 'challenged.account@gmail.com';
export const fixtureAccountRef = 'yt-live-fixture';
export const fixtureProfileRef = 'yt-live-profile-fixture';

export const fixtureRecording = {
  posts: [], challengeRenders: 0, challengeAnswers: 0, studioVisits: 0,
};

const resetRecording = () => { fixtureRecording.posts.length = 0; fixtureRecording.challengeRenders = 0;
  fixtureRecording.challengeAnswers = 0; fixtureRecording.studioVisits = 0; };

function service({ challenged = true } = {}) {
  const posts = fixtureRecording.posts;
  const homePage = username => `<nav><button aria-label="Account menu">Account</button></nav>`
    + `<main><h1>YouTube</h1><div id="identity"><a href="/feed">${username}</a></div>`
    + `<div><button>Switch account</button></div><div><button>Sign out</button></div>`
    + `<div><a href="https://accounts.google.com/AddSession">Add account</a></div></main>`;
  const studioPage = '<header><div id="channel-name">Fixture Channel</div></header>'
    + `<main><h1>Channel dashboard</h1><div id="identity"><a href="/feed">${challengedUsername}</a></div>`
    + '<div><button>Sign out</button></div></main>';
  const loginForm = '<p>Sign in to YouTube</p><form action="/login" method="post">'
    + '<input name="username" aria-label="Email or phone" autocomplete="username">'
    + '<input type="password" name="password" aria-label="Password">'
    + '<button>Log in</button></form>';
  const totpForm = '<p>Enter the code from your authenticator app</p><form action="/verify" method="post">'
    + '<input name="verificationCode" autocomplete="one-time-code" aria-label="Login code"><button>Confirm</button></form>';
  // No password input on the challenge surface: the operator screenshot must be
  // capturable, and the automation must never answer this form.
  const challengePage = '<p>Verify you are human</p><iframe src="/recaptcha/anchor" title="challenge"></iframe>'
    + '<form action="/challenge/answer" method="post"><input name="challengeCode" aria-label="Enter the code">'
    + '<button>Submit</button></form>'
    + '<button id="human" type="button">I am not a robot</button>'
    + '<script>document.getElementById("human").onclick = () => { location.href = "/challenge/continue"; };</script>';

  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const data = new URLSearchParams(body);
    const cookies = Object.fromEntries(String(request.headers.cookie || '').split('; ').filter(Boolean)
      .map(pair => pair.split('=')));
    const send = (status, html) => { response.writeHead(status, { 'Content-Type': 'text/html' }); response.end(html); };
    const redirect = location => { response.writeHead(302, { Location: location }); response.end(); };
    if (request.url === '/login' && request.method === 'GET') {
      if (cookies.fixture_session) return redirect('/');
      return send(200, loginForm);
    }
    if (request.url === '/login' && request.method === 'POST') {
      posts.push('password');
      if (data.get('password') !== fixturePassword) return send(200, '<p>Incorrect password</p>');
      response.setHeader('Set-Cookie', `fixture_pending=${data.get('username')}; HttpOnly; SameSite=Lax; Path=/`);
      if (challenged && data.get('username') === challengedUsername && cookies.fixture_challenge !== 'cleared') {
        fixtureRecording.challengeRenders++;
        return send(200, challengePage);
      }
      return send(200, totpForm);
    }
    if (request.url === '/recaptcha/anchor') return send(200, '<p>recaptcha fixture</p>');
    if (request.url === '/challenge/continue') {
      response.setHeader('Set-Cookie', 'fixture_challenge=cleared; HttpOnly; SameSite=Lax; Path=/');
      return send(200, totpForm);
    }
    if (request.url === '/challenge/answer' && request.method === 'POST') {
      fixtureRecording.challengeAnswers++; return send(200, '<p>Incorrect code</p>');
    }
    if (request.url === '/verify' && request.method === 'POST') {
      posts.push('totp');
      if (data.get('verificationCode') !== totp(fixtureSeed).code) return send(200, '<p>Incorrect code</p>');
      const user = cookies.fixture_pending || fixtureUsername;
      response.setHeader('Set-Cookie', `fixture_session=${user}; HttpOnly; SameSite=Lax; Path=/`);
      return redirect('/');
    }
    if (request.url === '/studio') {
      fixtureRecording.studioVisits++;
      if (!cookies.fixture_session) return redirect('/login');
      return send(200, studioPage);
    }
    if (request.url === '/' || request.url.startsWith('/feed')) {
      if (!cookies.fixture_session) return send(200, loginForm);
      return send(200, homePage(cookies.fixture_session));
    }
    return send(200, loginForm);
  });
  return { server, homePage, studioPage, challengePage, loginForm, totpForm };
}

export async function createFakeBackend({ challenged = true, humanCheckpointSeconds = 30,
  viewport = { width: 1280, height: 720 } } = {}) {
  resetRecording();
  const { server } = service({ challenged });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const site = { loginUrl: `${origin}/login`, homeUrl: `${origin}/`, origins: [origin], credentialOrigins: [origin] };
  const { chromium } = await loadPlaywright();
  let browser = null;
  try { browser = await chromium.launch({ channel: 'chrome', headless: true }); }
  catch { browser = await chromium.launch({ headless: true }); }

  const contexts = new Map(); // port -> context, so a reopened profile keeps its session
  const connectImpl = async port => {
    const context = contexts.get(port) || await browser.newContext({ viewport, deviceScaleFactor: 1 });
    if (!contexts.has(port)) contexts.set(port, context);
    const page = await context.newPage();
    return { page, context, browser: { isConnected: () => false, close: async () => {} } };
  };
  const apiState = { started: new Set(), profiles: new Set(), ports: new Map() };
  const api = {
    async create() { const id = `fixture-profile-${String(apiState.profiles.size + 1).padStart(4, '0')}`;
      apiState.profiles.add(id); return id; },
    async start(folderId, profileId) {
      const port = apiState.ports.get(profileId) || (51000 + apiState.ports.size + 1);
      apiState.ports.set(profileId, port);
      apiState.started.add(profileId); return port;
    },
    async stop(profileId) { apiState.started.delete(profileId); },
    async premiumProxy() { return { type: 'socks5', host: 'proxy.invalid', port: 1080 }; },
    async changeProxy() {},
    async status() { return { status: 'stopped' }; },
  };
  const accountIndex = accountsFromRecords([
    { ref: fixtureAccountRef, platform: 'youtube', username: challenged ? challengedUsername : fixtureUsername,
      password: fixturePassword, totp: fixtureSeed },
  ]);
  const job = { id: 'yt-live-fixture', platform: 'youtube',
    accountRef: fixtureAccountRef, profileRef: fixtureProfileRef };
  const config = { folderId: 'fixture-folder-0001', proxyMode: 'none', seedSites: [], verifyRestart: true,
    humanCheckpointSeconds, maxSteps: 20, maxSeconds: 180, headless: true };
  const guideFactory = () => {
    const choose = async request => ({ action: request.actions[0], confidence: 1, probability: 1,
      method: 'exact-single-match' });
    choose.metrics = { calls: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, usageComplete: true, exactActions: 0 };
    return choose;
  };
  const studioImpl = async ({ page, onStep, verifyOnly = false }) => {
    await page.goto(`${origin}/studio`, { waitUntil: 'domcontentloaded' });
    const authenticated = page.url().startsWith(origin) && !page.url().endsWith('/login');
    await onStep({ phase: 'youtube_studio', state: authenticated ? 'ready' : 'signed_out' });
    return { authenticated, state: authenticated ? 'ready' : 'signed_out', reason: null,
      url: `${origin}/studio`, channel: authenticated ? { name: 'Fixture Channel' } : null, verifyOnly };
  };
  // The live run reads the platform table at call time; the fixture overrides it
  // so the real adapter talks to the offline service.
  const originalSite = sites.youtube;
  sites.youtube = site;
  const contextsStarted = () => [...contexts.values()];
  return {
    origin, api, apiState, accountIndex, job, config, connectImpl, guideFactory, studioImpl, site,
    recording: fixtureRecording, contexts,
    pages: () => [...contexts.values()].flatMap(context => context.pages()),
    async close() {
      sites.youtube = originalSite;
      await Promise.all([...contexts.values()].map(context => context.close().catch(() => {})));
      await browser.close().catch(() => {});
      await new Promise(resolve => server.close(resolve));
    },
    contextsStarted,
  };
}
