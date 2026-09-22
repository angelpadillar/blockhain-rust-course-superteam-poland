import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright } from '../src/runner.mjs';
import { runLogin, sites } from '../src/login.mjs';
import { runJobBatch, validateJobs, waitForHuman, JobLog, CancelToken } from '../src/jobs.mjs';
import { accountsFromRecords } from '../src/accounts.mjs';
import { createRedactor, parseAccounts, totp } from '../src/core.mjs';
import { readJson } from '../src/storage.mjs';

// Real-browser coverage for the human-checkpoint hook: the flow must stop at a
// security checkpoint in the live browser, wait only, and resume once a person
// has cleared it. Nothing here answers a challenge, fills a code or switches
// identity, and no account ever signs in twice.
const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const password = 'private-password';
const challengedUser = 'challenged_user';
const fixtureUser = 'fixture_user';
const usernameByRef = { 'ig-account-01': challengedUser, 'ig-account-02': fixtureUser };
const challengedJob = { id: 'job-challenged', platform: 'instagram', accountRef: 'ig-account-01', profileRef: 'yt-profile-01' };
const fixtureJob = { id: 'job-fixture', platform: 'instagram', accountRef: 'ig-account-02', profileRef: 'yt-profile-02' };

const loginForm = '<p>Log into Instagram</p><form action="/login" method="post">'
  + '<input name="username" aria-label="Username"><input type="password" name="password" aria-label="Password">'
  + '<button>Log in</button></form>';
const totpForm = '<p>Enter the code from your authenticator app</p><form action="/verify" method="post">'
  + '<input name="verificationCode" autocomplete="one-time-code" aria-label="Login code"><button>Confirm</button></form>';
// A hosted challenge surface: challenge text, a challenge frame and the decoy
// password input a real provider page keeps on it. `#human` is only for a person.
const challengePage = '<p>Verify you are human</p><iframe src="/recaptcha/anchor" title="challenge"></iframe>'
  + '<form action="/challenge/answer" method="post"><input name="challengeCode" aria-label="Enter the code">'
  + '<button>Submit</button></form><input type="password" aria-label="Enter your password">'
  + '<button id="human" type="button">I am not a robot</button>'
  + '<script>document.getElementById("human").onclick = () => { location.href = "/challenge/continue"; };</script>';

// Offline stand-in for a provider: the challenged account always lands on the
// checkpoint, the other account signs in. Every submission is recorded so the
// tests can prove the automation never answered a challenge itself.
async function checkpointService(t, { authDelayMs = 0, resumeTo = 'totp' } = {}) {
  const posts = []; let challengeAnswers = 0;
  const homePage = username => `<nav><a href="/${username || fixtureUser}/">Profile</a>`
    + '<a href="/direct/inbox/">Messages</a></nav><p>Account home</p>';
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const data = new URLSearchParams(body);
    const cookies = Object.fromEntries(String(request.headers.cookie || '').split('; ').filter(Boolean)
      .map(pair => pair.split('=')));
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/login' && request.method === 'POST') {
      posts.push('password');
      if (data.get('password') !== password) return response.end('<p>Incorrect password</p>');
      // The sign-in attempt is pending for this session from here on.
      response.setHeader('Set-Cookie', `fixture_pending=${data.get('username')}; HttpOnly; SameSite=Lax; Path=/`);
      if (data.get('username') === challengedUser) { posts.push('challenge'); return response.end(challengePage); }
      if (authDelayMs) await new Promise(resolve => setTimeout(resolve, authDelayMs));
      return response.end(totpForm);
    }
    if (request.url === '/recaptcha/anchor') return response.end('<p>recaptcha fixture</p>');
    // What the provider shows once a person has cleared the challenge: either
    // the next sign-in step or the signed-in service itself.
    if (request.url === '/challenge/continue' && resumeTo === 'totp') return response.end(totpForm);
    if (request.url === '/challenge/continue') return response.end(homePage(cookies.fixture_pending));
    if (request.url === '/challenge/answer' && request.method === 'POST') {
      challengeAnswers++; return response.end('<p>Incorrect code</p>');
    }
    if (request.url === '/verify' && request.method === 'POST') {
      posts.push('totp');
      if (data.get('verificationCode') !== totp(seed).code) return response.end('<p>Incorrect code</p>');
      response.setHeader('Set-Cookie', `fixture_session=${cookies.fixture_pending || ''}; HttpOnly; SameSite=Lax; Path=/`);
      response.writeHead(302, { Location: '/' }); return response.end();
    }
    if (request.url === '/' && cookies.fixture_session) return response.end(homePage(cookies.fixture_session));
    response.end(loginForm);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { posts, origin, challengeAnswers: () => challengeAnswers,
    site: { loginUrl: `${origin}/login`, homeUrl: `${origin}/`, origins: [origin], credentialOrigins: [origin] } };
}

async function launchBrowser(t) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  return browser;
}

async function scratch(t, prefix) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// A life-cycle stub that fails loudly. Errors raised here happen inside the
// runner, which reports them as codes only, so the messages are kept for the
// assertion output.
function stubApi() {
  const state = { started: new Set(), peakProfiles: 0, ports: new Set(), profiles: new Set(), errors: [] };
  const guard = (name, task) => async (...args) => {
    try { return await task(...args); }
    catch (error) { state.errors.push(`${name}: ${error?.message || error}`); throw error; }
  };
  const api = {
    create: guard('create', async () => { const id = `profile-${String(state.profiles.size + 1).padStart(4, '0')}`;
      state.profiles.add(id); return id; }),
    start: guard('start', async (folderId, profileId) => {
      assert.equal(state.started.has(profileId), false, 'the same profile was started twice at once');
      state.started.add(profileId); state.peakProfiles = Math.max(state.peakProfiles, state.started.size);
      const port = 50000 + Number(profileId.split('-')[1]); state.ports.add(port); return port;
    }),
    stop: guard('stop', async profileId => { assert.equal(state.started.delete(profileId), true); }),
    premiumProxy: guard('premiumProxy', async () => ({ type: 'socks5', host: 'proxy.example', port: 1080 })),
    changeProxy: guard('changeProxy', async () => {}),
    status: guard('status', async () => ({ status: 'stopped' })),
  };
  return { api, state };
}

// Every profile gets its own browser context and keeps it across restarts, the
// way a Multilogin profile keeps its session: concurrent jobs cannot mix and a
// reopened profile still sees the cookies it signed in with.
function connectFactory({ browser, contexts }) {
  const byPort = new Map();
  return async port => {
    const context = byPort.get(port) || await browser.newContext();
    const page = await context.newPage();
    if (!byPort.has(port)) { byPort.set(port, context); contexts.push(context); }
    return { page, context, browser: { isConnected: () => false, close: async () => {} } };
  };
}

const batchConfig = { folderId: 'folder-0001', proxyMode: 'none', seedSites: [], verifyRestart: true };
// Deterministic model stand-in: the login flow is recognized, so the only
// decision it can need is the first permitted action of a multi-field screen.
const guideFactory = () => {
  const choose = async request => ({ action: request.actions[0], confidence: 1, probability: 1 });
  choose.metrics = { calls: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0, usageComplete: true, exactActions: 0 };
  return choose;
};

// The runner reduces a flow failure to an error code, so the flow is wrapped to
// keep the real message and the failing source line for the assertion output.
function flowWithDiagnostics(state) {
  return async args => {
    try { return await runLogin(args); }
    catch (error) {
      const line = String(error?.stack).split('\n').find(entry => entry.includes('/src/')) || '';
      state.errors.push(`flow ${error?.name}: ${error?.message} @${line.trim()}`);
      throw error;
    }
  };
}

async function batchFixture(t, { jobsSpec, connectImpl, config = {}, concurrency = 1, onJobState = null }) {
  const directory = await scratch(t, 'jev-batch-checkpoint-');
  const { api, state } = stubApi();
  const result = await runJobBatch({ jobs: validateJobs({ jobs: jobsSpec }),
    accountIndex: accountsFromRecords(jobsSpec.map(job => ({ ref: job.accountRef, platform: 'instagram',
      username: usernameByRef[job.accountRef], password, totp: seed }))),
    config: { ...batchConfig, ...config }, directory, concurrency, api, guideFactory, connectImpl, onJobState,
    flowImpl: flowWithDiagnostics(state) });
  return { result, directory, state };
}

// A person clears the challenge in the first browser context the job opened.
// They take a moment to do it, like a real person would.
async function personClearsCheckpoint(contexts, { delayMs = 600 } = {}) {
  while (!contexts.length) await new Promise(resolve => setTimeout(resolve, 25));
  const page = contexts[0].pages()[0];
  await page.waitForSelector('#human', { timeout: 20000 });
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return page.locator('#human').click();
}

// The batch runner resolves the platform site from the shared table at call
// time, so a job can be pointed at the offline stand-in instead of the network.
function useFixtureSite(t, site) {
  const original = sites.instagram;
  sites.instagram = site;
  t.after(() => { sites.instagram = original; });
}

test('a real browser login resumes after a person clears the checkpoint without spending its time budget', async t => {
  // Clearing the last checkpoint lands on the signed-in service, so the only
  // thing that can expire here is the login budget.
  const service = await checkpointService(t, { resumeTo: 'home' });
  const browser = await launchBrowser(t);
  const context = await browser.newContext(); t.after(() => context.close());
  const page = await context.newPage();
  const directory = await scratch(t, 'jev-checkpoint-');
  const account = parseAccounts(`${challengedUser};${password};${seed}`, 'instagram')[0];
  const log = new JobLog({ directory, job: challengedJob,
    redact: createRedactor([account.username, account.password, account.totp]) });
  await log.init();
  const checkpoints = []; const shots = []; const steps = [];
  // The person takes longer than the whole login budget before clearing it.
  const person = (async () => {
    await page.waitForSelector('#human', { timeout: 20000 });
    const beforePerson = await page.locator('input[name=challengeCode]').inputValue();
    await new Promise(resolve => setTimeout(resolve, 2300));
    await page.locator('#human').click();
    return beforePerson;
  })();
  const result = await runLogin({ page, account, site: service.site, maxSeconds: 2, maxSteps: 20,
    choose: async request => { steps.push(request); return { action: request.actions[0], confidence: 1, probability: 1 }; },
    onStep: async detail => steps.push(detail),
    requestHumanCheckpoint: async context => {
      checkpoints.push({ reason: context.reason, url: context.page.url(),
        hasBrowser: typeof context.browser?.observe === 'function' });
      shots.push(await log.screenshot(context.page, `checkpoint_${context.reason}`, service.site.credentialOrigins));
      return waitForHuman({ reason: context.reason, observe: () => context.browser.observe(), log,
        config: { humanCheckpointSeconds: 30 }, cancel: new CancelToken(), pollMs: 250,
        onStep: async detail => steps.push(detail) });
    } });
  assert.equal(await person, '', 'the challenge code field was untouched while waiting for a person');
  assert.equal(result.verified, true);
  // The person took longer than the whole budget, so only the added wait can
  // explain a login that still completed instead of timing out.
  assert.ok(result.durationMs > 2000 && result.durationMs < 6000, `waited ${result.durationMs}ms`);
  assert.deepEqual(checkpoints.map(entry => entry.reason), ['human_verification_required']);
  assert.equal(checkpoints[0].hasBrowser, true);
  assert.equal(checkpoints[0].url, `${service.origin}/login`);
  // Screenshot evidence stops while a password field is on screen.
  assert.deepEqual(shots, [{ skipped: 'credential_entry_visible' }]);
  assert.deepEqual(await readdir(join(directory, 'screenshots')), []);
  // Waiting is a real transition, not a terminal failure.
  assert.deepEqual(log.transitions.map(item => item.state), ['waiting_for_human', 'running']);
  assert.ok(log.transitions[1].waitedMs >= 2000);
  assert.deepEqual(steps.filter(detail => detail.phase === 'human_checkpoint').map(detail => detail.state),
    ['waiting', 'resolved']);
  assert.deepEqual(steps.filter(detail => detail.phase === 'attention').map(detail => detail.reason),
    ['human_verification_required']);
  // One credential submission, one checkpoint, and nothing submitted while the
  // automation was waiting.
  assert.deepEqual(service.posts, ['password', 'challenge']);
  assert.equal(service.challengeAnswers(), 0, 'the automation never answered the challenge');
  const events = await readFile(join(directory, 'events.ndjson'), 'utf8');
  for (const secret of [password, seed, challengedUser]) {
    assert.equal(events.includes(secret), false, `events must not contain ${secret}`);
  }
});

test('the batch runner resumes a checkpointed job in the browser it is holding', async t => {
  const service = await checkpointService(t);
  useFixtureSite(t, service.site);
  const browser = await launchBrowser(t);
  const contexts = []; t.after(() => Promise.all(contexts.map(context => context.close())));
  const states = [];
  const person = personClearsCheckpoint(contexts);
  const fixture = await batchFixture(t, { jobsSpec: [challengedJob], connectImpl: connectFactory({ browser, contexts }),
    config: { humanCheckpointSeconds: 30 }, onJobState: entry => states.push({ ...entry, at: Date.now() }) });
  const [job] = fixture.result.summary.jobs;
  assert.equal(job.state, 'success', `${job.reason} ${fixture.state.errors}`);
  const directory = join(fixture.directory, 'jobs', 'job-challenged');
  const document = await readJson(join(directory, 'job.json'));
  assert.equal(document.login.verified, true);
  assert.equal(document.login.reopenVerified, true);
  for (const state of ['queued', 'starting_profile', 'browser_ready', 'waiting_for_human', 'running', 'success']) {
    assert.ok(document.stateTransitions.some(item => item.state === state), state);
  }
  assert.ok(states.some(entry => entry.state === 'waiting_for_human'));
  assert.ok(states.some(entry => entry.state === 'success'));
  // The checkpoint screenshot is skipped while a password field is on screen,
  // and every other transition keeps its own evidence file.
  assert.deepEqual(document.screenshots.find(item => item.label === 'checkpoint_human_verification_required'),
    { label: 'checkpoint_human_verification_required', skipped: 'credential_entry_visible' });
  assert.ok(document.screenshots.some(item => item.label === 'login_verified' && item.path));
  const files = await readdir(join(directory, 'screenshots'));
  assert.equal(files.length, document.screenshots.filter(item => item.path).length);
  assert.ok(files.length >= 3, 'transitions capture screenshots');
  for (const file of files) {
    assert.match(file, /\.png$/);
    assert.ok((await readFile(join(directory, 'screenshots', file))).length > 0);
  }
  assert.deepEqual(service.posts, ['password', 'challenge', 'totp'], 'credentials are submitted once each');
  assert.equal(service.challengeAnswers(), 0, 'the automation never answered the challenge');
  assert.deepEqual(await readdir(join(fixture.directory, 'locks')), []);
  assert.equal(fixture.state.started.size, 0, 'every profile was stopped');
  const registry = await readJson(join(fixture.directory, 'profile-refs.json'));
  assert.ok(registry.refs['yt-profile-01'].profileId, 'the profile stays mapped for its rerun');
  const raw = await readFile(join(directory, 'job.json'), 'utf8');
  const events = await readFile(join(directory, 'events.ndjson'), 'utf8');
  for (const secret of [password, seed, challengedUser]) {
    assert.equal(raw.includes(secret), false, `job.json must not contain ${secret}`);
    assert.equal(events.includes(secret), false, `events must not contain ${secret}`);
  }
  // The person finished in the page the job kept open, without a rerun.
  await person;
});

test('a job waiting for a person does not block another worker and keeps its evidence isolated', async t => {
  const service = await checkpointService(t, { authDelayMs: 400 });
  useFixtureSite(t, service.site);
  const browser = await launchBrowser(t);
  const contexts = []; t.after(() => Promise.all(contexts.map(context => context.close())));
  const states = [];
  const fixture = await batchFixture(t, { jobsSpec: [challengedJob, fixtureJob], concurrency: 2,
    connectImpl: connectFactory({ browser, contexts }), config: { humanCheckpointSeconds: 2 },
    onJobState: entry => states.push({ ...entry, at: Date.now() }) });
  const byId = Object.fromEntries(fixture.result.summary.jobs.map(job => [job.id, job]));
  const challenged = join(fixture.directory, 'jobs', 'job-challenged');
  const finished = join(fixture.directory, 'jobs', 'job-fixture');
  const challengedDocument = await readJson(join(challenged, 'job.json'));
  const finishedDocument = await readJson(join(finished, 'job.json'));
  assert.equal(byId['job-fixture'].state, 'success',
    `${byId['job-fixture'].reason} ${finishedDocument.logFailures} ${fixture.state.errors}`);
  assert.equal(byId['job-challenged'].state, 'waiting_for_human',
    `${byId['job-challenged'].reason} ${challengedDocument.logFailures}`);
  assert.equal(byId['job-challenged'].reason, 'human_checkpoint_timeout');
  assert.equal(fixture.result.report.peakWorkers, 2);
  assert.equal(fixture.state.peakProfiles, 2, 'both profiles ran at once');
  assert.equal(fixture.state.ports.size, 2);
  assert.equal(fixture.state.profiles.size, 2);
  assert.equal(fixture.state.started.size, 0, 'every profile was stopped');
  const waiting = states.find(entry => entry.jobId === 'job-challenged' && entry.state === 'waiting_for_human');
  assert.ok(waiting, 'the checkpointed job reports its wait');
  assert.ok(states.some(entry => entry.jobId === 'job-fixture' && entry.state === 'success' && entry.at >= waiting.at),
    'the other worker finished while its sibling waited for a person');
  // Per-job evidence: own profile, own worker directory, own log, own screenshots.
  assert.notEqual(challengedDocument.profileId, finishedDocument.profileId);
  assert.notEqual(challengedDocument.accountId, finishedDocument.accountId);
  assert.deepEqual(challengedDocument.screenshots.find(item => item.label === 'checkpoint_human_verification_required'),
    { label: 'checkpoint_human_verification_required', skipped: 'credential_entry_visible' });
  assert.equal(challengedDocument.screenshots.some(item => item.label === 'login_verified'), false,
    'the waiting job has no completed login');
  assert.ok(finishedDocument.screenshots.some(item => item.label === 'login_verified' && item.path));
  assert.equal((await readdir(join(challenged, 'screenshots'))).length,
    challengedDocument.screenshots.filter(item => item.path).length);
  for (const [mine, theirs] of [[challengedDocument, finishedDocument], [finishedDocument, challengedDocument]]) {
    const raw = await readFile(join(fixture.directory, 'jobs', mine.jobId, 'job.json'), 'utf8');
    const events = await readFile(join(fixture.directory, 'jobs', mine.jobId, 'events.ndjson'), 'utf8');
    assert.equal(raw.includes(theirs.profileRef), false, 'a job log never mentions another job');
    assert.equal(raw.includes(theirs.accountRef), false, 'a job log never mentions another account');
    assert.equal(raw.includes(usernameByRef[theirs.accountRef]), false, 'a job log never mentions another username');
    for (const secret of [password, seed, usernameByRef[mine.accountRef]]) {
      assert.equal(raw.includes(secret), false, `job.json must not contain ${secret}`);
      assert.equal(events.includes(secret), false, `events must not contain ${secret}`);
    }
  }
  const workers = await readdir(join(fixture.directory, 'accounts'));
  assert.equal(workers.length, 2, 'each job owns its account worker directory');
  for (const worker of workers) {
    const child = await readJson(join(fixture.directory, 'accounts', worker, 'profiles.json'));
    assert.deepEqual(Object.keys(child.profiles), [worker]);
  }
  assert.deepEqual(await readdir(join(fixture.directory, 'locks')), []);
  const registry = await readJson(join(fixture.directory, 'profile-refs.json'));
  assert.ok(registry.refs['yt-profile-01'].profileId && registry.refs['yt-profile-02'].profileId);
  assert.equal(service.challengeAnswers(), 0, 'the automation never answered the challenge');
  assert.equal(service.posts.filter(post => post === 'totp').length, 1, 'only the completed job submitted a code');
  assert.equal(service.posts.filter(post => post === 'challenge').length, 1);
});
