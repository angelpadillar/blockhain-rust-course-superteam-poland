import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Prompt → action interface.
//
//   npm run browser:prompt -- "status"
//   npm run browser:prompt -- "setup outlook+linkedin for ol-01..ol-05" --remote
//   npm run browser:prompt -- "login linkedin for ol-01" --remote
//   npm run browser:prompt -- "run jobs/youtube-live-batch.example.json"
//
// The prompt is parsed DETERMINISTICALLY into a plan (no model call): a sequence
// of single-profile jobs. A multi-step identity (Outlook first, then LinkedIn)
// runs on the SAME Multilogin profile, strictly sequentially, one account at a
// time. Every step reuses the tested single-job runner, so profile ownership,
// recovery, checkpoints, health and Discord alerts behave exactly as they do for
// any other job. `--dry-run` prints the plan and the exact commands.
const here = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(here, '..');
const repoRoot = resolve(packageDirectory, '..', '..');

export const supportedPlatforms = ['outlook', 'linkedin', 'instagram', 'youtube'];

export function expandRefs(value) {
  if (!value) return [];
  const refs = [];
  for (const part of String(value).split(',')) {
    const token = part.trim();
    const range = /^([a-zA-Z]+)-(\d+)\.\.([a-zA-Z]*)-?(\d+)$/.exec(token);
    if (range) {
      const prefix = range[1];
      const from = Number(range[2]);
      const to = Number(range[4]);
      const width = Math.max(range[2].length, range[4].length);
      for (let index = from; index <= to; index++) refs.push(`${prefix}-${String(index).padStart(width, '0')}`);
      continue;
    }
    if (token) refs.push(token);
  }
  return refs;
}

// Parse the operator's sentence into a plan. Only the documented shapes are
// accepted; anything else returns a help plan instead of guessing.
export function parsePrompt(text, { refs = null, accountsFile = null, platforms = null } = {}) {
  const prompt = String(text || '').trim();
  const lower = prompt.toLowerCase();
  const refsFromText = /(?:for|refs?)\s+((?:[a-z]+-\d+)(?:\.\.[a-z]*-?\d+)?(?:,\s*(?:[a-z]+-\d+)(?:\.\.[a-z]*-?\d+)?)*)/i.exec(prompt)?.[1] || null;
  const resolvedRefs = refs ? expandRefs(refs) : refsFromText ? expandRefs(refsFromText) : [];
  const jsonFile = /([\w./-]+\.json)/.exec(prompt)?.[1] || null;
  const platformWords = (lower.match(/\b(outlook|linkedin|instagram|youtube)\b/g) || []);
  const requestedPlatforms = platforms
    || [...new Set(platformWords.length ? platformWords : [])];
  const accounts = accountsFile || (jsonFile && !jsonFile.includes('jobs/') ? jsonFile : 'accounts-outlook-linkedin.json');

  if (/^\s*(status|profiles)\b/.test(lower)) {
    return { intent: 'status', prompt, platforms: platformWords.includes('youtube') ? ['youtube'] : [] };
  }
  if (/^\s*run\s+/.test(lower) && jsonFile) {
    return { intent: 'run', prompt, jobsFile: jsonFile };
  }
  if (/(setup|set up|onboard|create profiles|log ?in|log into|sign in)/.test(lower)) {
    const wantsPair = /outlook/.test(lower) && /linkedin/.test(lower);
    const chosen = wantsPair ? ['outlook', 'linkedin'] : requestedPlatforms;
    if (!chosen.length) return { intent: 'help', prompt, reason: 'no_platform_recognized' };
    return { intent: 'login', prompt, platforms: chosen, refs: resolvedRefs, accountsFile: accounts };
  }
  return { intent: 'help', prompt, reason: 'unrecognized_prompt' };
}

// A multi-step identity: one profile per account, one sequential job per step.
export function planJobs({ platforms, refs, accountsFile }) {
  const jobs = [];
  for (const ref of refs) {
    const profileRef = `profile-${ref}`;
    for (const platform of platforms) {
      jobs.push({ id: `${ref}-${platform}`, platform, accountRef: ref, profileRef });
    }
  }
  return jobs;
}

export function renderPlan({ plan, jobs }) {
  const lines = [`prompt: ${plan.prompt}`, `intent: ${plan.intent}`];
  if (plan.accountsFile) lines.push(`accounts: ${plan.accountsFile}`);
  if (jobs.length) {
    lines.push('plan (sequential, one profile per account):');
    for (const job of jobs) {
      lines.push(`  ${job.id.padEnd(24, ' ')} ${job.platform.padEnd(10, ' ')} ${job.accountRef} -> ${job.profileRef}`);
    }
    lines.push(`${jobs.length} job(s), ${new Set(jobs.map(job => job.profileRef)).size} profile(s)`);
  }
  return lines.join('\n');
}

function jobRunnerArguments({ jobFile, data, config, accounts, tokenFile, keyFile, extra = [] }) {
  const args = [resolve(packageDirectory, 'job-runner.mjs'), jobFile,
    '--data', data, '--config', config, '--accounts', accounts,
    '--token-file', tokenFile, '--provider', 'fireworks', '--key-file', keyFile];
  return [...args, ...extra];
}

export function remoteJobCommand({ jobFile, accounts, host = 'root@100.121.5.10',
  directory = '/opt/buena-multilogin', data = '/data/account-pilot' } = {}) {
  return `ssh ${host} "cd ${directory} && docker compose run --rm --no-deps -T`
    + ` -v ${directory}-orchestrator/src:/app/src:ro -v ${directory}-orchestrator/job-runner.mjs:/app/job-runner.mjs:ro`
    + ` --entrypoint node worker job-runner.mjs /data/jobs/${jobFile} --data ${data}`
    + ` --config config.vps.json --accounts ${accounts} --token-file /data/automation-token`
    + ` --provider fireworks --key-file /data/fireworks-api-key"`;
}

export function parseArguments(argv = []) {
  const options = { positional: [], extra: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--dry-run') options.dryRun = true;
    else if (token === '--remote') {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) { options.remote = next; index++; } else options.remote = true;
    } else if (token === '--local') options.local = true;
    else if (['--refs', '--accounts-file', '--accounts', '--data', '--config', '--token-file', '--key-file', '--jobs-dir']
      .includes(token)) {
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.startsWith('--')) throw new Error(`missing value for ${token}`);
      options[token.slice(2)] = value; index++;
    } else if (token === '--youtube') options.extra.push('--youtube');
    else if (token === '--no-notify') options.extra.push('--no-notify');
    else options.positional.push(token);
  }
  return options;
}

async function runCommand(command, args, { cwd = packageDirectory } = {}) {
  const child = spawn(command, args, { stdio: 'inherit', cwd });
  return new Promise(resolvePromise => child.once('exit', code => resolvePromise(code ?? 1)));
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const prompt = options.positional.join(' ').trim();
  if (!prompt) {
    console.log('Usage: npm run browser:prompt -- "<prompt>" [--remote] [--dry-run]\n'
      + 'Examples:\n'
      + '  "status"\n'
      + '  "setup outlook+linkedin for ol-01..ol-05" --remote\n'
      + '  "login linkedin for ol-01" --remote');
    return 0;
  }
  const plan = parsePrompt(prompt, { refs: options.refs, accountsFile: options['accounts-file'],
    platforms: options.extra.includes('--youtube') ? ['youtube'] : null });
  if (plan.intent === 'help') {
    console.error(JSON.stringify({ status: 'help', prompt, reason: plan.reason }));
    return 2;
  }
  if (plan.intent === 'status') {
    if (options.remote) {
      return runCommand(process.execPath, [resolve(packageDirectory, 'scripts', 'profiles.mjs'), '--remote',
        ...options.extra.filter(item => item !== '--no-notify')]);
    }
    return runCommand(process.execPath, [resolve(packageDirectory, 'profile-health-cli.mjs'),
      ...options.extra.filter(item => item !== '--no-notify')]);
  }
  if (plan.intent === 'run') {
    const jobsFile = resolve(repoRoot, plan.jobsFile);
    if (options.dryRun) { console.log(JSON.stringify({ plan: 'run', jobsFile }, null, 2)); return 0; }
    if (!options.remote) return runCommand(process.execPath, [resolve(packageDirectory, 'batch-runner.mjs'), jobsFile,
      '--concurrency', '1']);
    // Remote: reuse the single-job wrapper for every job in the file, in order.
    const { jobs: fileJobs } = JSON.parse(await (await import('node:fs/promises')).readFile(jobsFile, 'utf8'));
    const host = options.remote === true ? (process.env.BROWSER_JOB_HOST || 'root@100.121.5.10') : options.remote;
    const jobsDirectory = resolve(options['jobs-dir'] || resolve(repoRoot, 'jobs'), 'generated');
    await mkdir(jobsDirectory, { recursive: true });
    let code = 0;
    for (const job of fileJobs) {
      const single = resolve(jobsDirectory, `${job.id}.json`);
      await writeFile(single, `${JSON.stringify({ jobs: [job] }, null, 2)}\n`, { mode: 0o600 });
      code = await runCommand(process.execPath, [resolve(packageDirectory, 'scripts', 'job.mjs'), single,
        '--remote', host, ...options.extra.filter(item => item !== '--youtube')]);
      if (code !== 0) break;
    }
    process.exitCode = code;
    return code;
  }
  // login / setup
  const refs = plan.refs?.length ? plan.refs : [];
  if (!refs.length) { console.error(JSON.stringify({ status: 'help', reason: 'no_account_refs' })); return 2; }
  const jobs = planJobs({ platforms: plan.platforms, refs, accountsFile: plan.accountsFile });
  const jobsDirectory = resolve(options['jobs-dir'] || resolve(repoRoot, 'jobs'), 'generated');
  await mkdir(jobsDirectory, { recursive: true });
  const jobsFile = resolve(jobsDirectory, `${refs[0]}-${plan.platforms.join('-')}.json`);
  await writeFile(jobsFile, `${JSON.stringify({ jobs }, null, 2)}\n`, { mode: 0o600 });
  console.log(renderPlan({ plan, jobs }));
  console.log(`jobs file: ${jobsFile}`);

  const host = options.remote === true ? (process.env.BROWSER_JOB_HOST || 'root@100.121.5.10') : options.remote || null;
  const accounts = options.accounts || `/data/${plan.accountsFile.split('/').pop()}`;
  if (options.dryRun) {
    if (host) {
      console.log('commands:');
      for (const job of jobs) console.log(`  ${remoteJobCommand({ jobFile: `${job.id}.json`, accounts, host })}`);
    } else {
      console.log('commands:');
      for (const job of jobs) {
        console.log(`  node job-runner.mjs ${job.id}.json --data ${options.data || 'private/state'} --accounts ${accounts}`);
      }
    }
    return 0;
  }
  // Execute strictly sequentially, one step at a time; a failure stops the plan.
  let exitCode = 0;
  for (const job of jobs) {
    if (host) {
      // Upload the single-job file through the tested remote wrapper.
      const single = resolve(jobsDirectory, `${job.id}.json`);
      await writeFile(single, `${JSON.stringify({ jobs: [job] }, null, 2)}\n`, { mode: 0o600 });
      const code = await runCommand(process.execPath, [resolve(packageDirectory, 'scripts', 'job.mjs'), single,
        '--remote', host, '--accounts', accounts, ...options.extra.filter(item => item !== '--youtube')]);
      if (code !== 0 && code !== 2) { exitCode = code; break; }
      if (code === 2) { console.log(JSON.stringify({ event: 'plan_paused', jobId: job.id,
        reason: 'waiting_for_human', detail: 'resolve the checkpoint, then rerun the same prompt' })); exitCode = 2; break; }
    } else {
      const single = resolve(jobsDirectory, `${job.id}.json`);
      await writeFile(single, `${JSON.stringify({ jobs: [job] }, null, 2)}\n`, { mode: 0o600 });
      const code = await runCommand(process.execPath, jobRunnerArguments({ jobFile: single,
        data: options.data || resolve(packageDirectory, 'private/state'),
        config: options.config || resolve(packageDirectory, 'config.vps.json'),
        accounts: options.accounts || resolve(packageDirectory, 'private/accounts.json'),
        tokenFile: options['token-file'] || resolve(packageDirectory, 'private/multilogin-token'),
        keyFile: options['key-file'] || resolve(packageDirectory, 'private/fireworks-api-key'),
        extra: options.extra }));
      if (code !== 0 && code !== 2) { exitCode = code; break; }
      if (code === 2) { exitCode = 2; break; }
    }
  }
  process.exitCode = exitCode;
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ status: 'stopped', reason: error?.code || error?.message || 'error' }));
    process.exitCode = 1; });
}
