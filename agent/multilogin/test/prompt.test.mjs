import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRefs, parsePrompt, planJobs, renderPlan, remoteJobCommand,
  parseArguments, supportedPlatforms } from '../scripts/prompt.mjs';

test('account refs expand ranges in both directions', () => {
  assert.deepEqual(expandRefs('ol-01..ol-03'), ['ol-01', 'ol-02', 'ol-03']);
  assert.deepEqual(expandRefs('ol-1..3'), ['ol-1', 'ol-2', 'ol-3']);
  assert.deepEqual(expandRefs('ol-01,ol-05'), ['ol-01', 'ol-05']);
  assert.deepEqual(expandRefs(''), []);
});

test('the prompt grammar maps sentences to plans without a model', () => {
  const setup = parsePrompt('setup outlook+linkedin for ol-01..ol-05');
  assert.equal(setup.intent, 'login');
  assert.deepEqual(setup.platforms, ['outlook', 'linkedin']);
  assert.deepEqual(setup.refs, ['ol-01', 'ol-02', 'ol-03', 'ol-04', 'ol-05']);
  const login = parsePrompt('log into linkedin for ol-02');
  assert.deepEqual(login.platforms, ['linkedin']);
  assert.deepEqual(login.refs, ['ol-02']);
  assert.equal(parsePrompt('status').intent, 'status');
  assert.equal(parsePrompt('run jobs/youtube-live-batch.example.json').intent, 'run');
  assert.equal(parsePrompt('make me a sandwich').intent, 'help');
  assert.equal(parsePrompt('login linkedin for ol-01').platforms[0], 'linkedin');
  for (const platform of ['outlook', 'linkedin']) assert.ok(supportedPlatforms.includes(platform));
});

test('one profile per account, outlook before linkedin, strictly sequential', () => {
  const jobs = planJobs({ platforms: ['outlook', 'linkedin'], refs: ['ol-01', 'ol-02'], accountsFile: 'x.json' });
  assert.deepEqual(jobs.map(job => job.id), ['ol-01-outlook', 'ol-01-linkedin', 'ol-02-outlook', 'ol-02-linkedin']);
  assert.deepEqual(jobs.map(job => job.profileRef), ['profile-ol-01', 'profile-ol-01', 'profile-ol-02', 'profile-ol-02']);
  assert.equal(jobs.every(job => job.accountRef.startsWith('ol-')), true);
  const rendered = renderPlan({ plan: { prompt: 'x', intent: 'login', accountsFile: 'a.json' }, jobs });
  assert.match(rendered, /2 profile\(s\)/);
  assert.match(rendered, /ol-01-outlook\s+outlook\s+ol-01 -> profile-ol-01/);
});

test('the remote command never carries a credential value', () => {
  const command = remoteJobCommand({ jobFile: 'ol-01-outlook.json', accounts: '/data/accounts-outlook-linkedin.json' });
  assert.match(command, /job-runner\.mjs \/data\/jobs\/ol-01-outlook\.json/);
  assert.match(command, /--accounts \/data\/accounts-outlook-linkedin\.json/);
  assert.match(command, /--token-file \/data\/automation-token/);
  assert.equal(/Bearer\s|sk-[a-zA-Z0-9]|https:\/\/discord\.com/.test(command), false);
});

test('argument parsing keeps the operator flags and ignores nothing silently', () => {
  const options = parseArguments(['setup outlook+linkedin for ol-01', '--remote', '--dry-run', '--no-notify']);
  assert.equal(options.remote, true);
  assert.equal(options.dryRun, true);
  assert.deepEqual(options.extra, ['--no-notify']);
  assert.equal(parseArguments(['status', '--remote', 'root@example.test']).remote, 'root@example.test');
  assert.throws(() => parseArguments(['status', '--refs']), /missing value/);
});
