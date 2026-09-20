import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { parseAccounts, requireThat, errorCode, PilotError } from '../src/core.mjs';
import { Multilogin } from '../src/multilogin.mjs';
import { createJev } from '../src/jev.mjs';
import { runConcurrentBatch } from '../src/batch.mjs';
import { LoginBrowser, navigate, verifyIdentity, runLogin } from '../src/login.mjs';

// Explicitly authorized inspection of the single retained Instagram checkpoint.
// Opening Continue reveals the requirement; it does not submit identity evidence.
async function inspectCheckpoint({ page, account, choose, onStep, verifyOnly }) {
  if (verifyOnly) return runLogin({ page, account, choose, onStep, verifyOnly: true });
  const adapter = new LoginBrowser(page, account);
  await navigate(page, 'https://www.instagram.com/');
  let snapshot;
  for (let i = 0; i < 20; i++) {
    snapshot = await adapter.observe();
    if (verifyIdentity(account, snapshot)) return { verified: true, steps: 0 };
    if (/confirm you.re human/i.test(snapshot.text) && snapshot.controls.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await onStep({ phase: 'checkpoint_before', page: adapter.publicPage(snapshot) });
  requireThat(new URL(snapshot.url).pathname === '/accounts/suspended/'
    && /confirm you.re human/i.test(snapshot.text), 'checkpoint_screen_changed');
  const controls = snapshot.controls.filter(control => control.enabled && control.label.trim().toLowerCase() === 'continue');
  requireThat(controls.length === 1, 'checkpoint_continue_not_unique');
  const actions = [{ id: 'continue', description: 'Open the observed Continue control to reveal the verification instructions; this does not submit identity evidence.' }];
  const decision = await choose({ page: adapter.publicPage(snapshot), actions });
  requireThat(decision.action.id === 'continue', 'checkpoint_selection_invalid');
  await onStep({ phase: 'checkpoint_continue', confidence: decision.confidence, probability: decision.probability, state: 'before' });
  await adapter.execute({ kind: 'submit_login', control: controls[0] }, snapshot);
  await page.waitForTimeout(4000);
  snapshot = await adapter.observe();
  const frames = [];
  for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
    let url; try { url = new URL(frame.url()); } catch { continue; }
    const description = { origin: url.origin, path: adapter.redact(url.pathname) };
    if (['https://www.google.com', 'https://www.recaptcha.net', 'https://newassets.hcaptcha.com'].includes(url.origin)) {
      description.text = adapter.redact(await frame.locator('body').innerText({ timeout: 1500 }).catch(() => '')).slice(0, 2500);
      description.controls = await frame.locator('input,button,[role="checkbox"],[role="button"]').evaluateAll(elements => elements.map(element => ({
        tag: element.tagName.toLowerCase(), role: element.getAttribute('role'), type: element.getAttribute('type'),
        label: element.getAttribute('aria-label') || element.innerText || '',
      }))).catch(() => []);
      description.controls = description.controls.map(control => ({ ...control, label: adapter.redact(control.label).slice(0, 250) }));
    }
    frames.push(description);
  }
  await onStep({ phase: 'checkpoint_after', page: adapter.publicPage(snapshot), frames });
  if (verifyIdentity(account, snapshot)) return { verified: true, steps: 1 };
  throw new PilotError('checkpoint_observed');
}

try {
  const input = createInterface({ input: process.stdin, terminal: false });
  const secrets = JSON.parse(await new Promise(resolve => input.once('line', resolve))); input.close();
  const accounts = parseAccounts(JSON.stringify(secrets.accounts));
  requireThat(accounts.length === 1 && accounts[0].id === 'd30eedb5cc49c4e2b514', 'checkpoint_account_not_authorized');
  const config = JSON.parse(await readFile('config.vps.json', 'utf8')); config.seedSites = [];
  const api = new Multilogin({ token: secrets.multiloginToken, launcherUrl: config.launcherUrl });
  const result = await runConcurrentBatch({ accounts, config, api, concurrency: 1, directory: '/data/account-pilot',
    loginImpl: inspectCheckpoint, guideFactory: () => createJev({ apiKey: secrets.typesafeKey,
      goal: 'Inspect the next verification instructions for the supplied existing account by opening its Continue control. Do not submit identity evidence, change settings, or create an account.' }) });
  console.log(JSON.stringify(result.report, null, 2));
} catch (error) { console.error(JSON.stringify({ status: 'stopped', reason: errorCode(error) })); process.exitCode = 1; }
