import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { acquireProfileLock } from './storage.mjs';
import { allowedUrl, allowedMutation, allowedInteractiveAuth, freeEditEvidence, assert, FORBIDDEN, permittedControl, Stop } from './policy.mjs';
const CONTROLS = 'button,a,input,textarea,select,[role="button"],[role="option"],[role="tab"]';
// Read only rendered DOM. No app stores, network calls, or caller-supplied JavaScript.
function readDom(body, selector) {
  const visible = e => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const label = e => (e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.getAttribute('placeholder') || e.innerText || e.getAttribute('title') || '').trim();
  const dialog = [...body.querySelectorAll('[role="dialog"],dialog')].filter(visible).at(-1);
  const controls = [...body.querySelectorAll(selector)].map((e, index) => ({ index, visible: visible(e),
    disabled: !!e.disabled || e.getAttribute('aria-disabled') === 'true', label: label(e).slice(0, 180),
    tag: e.tagName.toLowerCase(), role: e.getAttribute('role') || '', type: e.getAttribute('type') || '',
    value: ['number', 'text'].includes(e.type) ? e.value : '', href: e.tagName === 'A' ? e.getAttribute('href') : null,
    context: (e.closest('[role="dialog"],dialog')?.innerText || '').slice(0, 1000), inDialog: !!dialog?.contains(e) }));
  return { text: body.innerText.slice(0, 18000), controls: controls.filter(c => !dialog || c.inDialog),
    files: [...body.querySelectorAll('input[type="file"]')].map((e, index) => ({ index, accept: e.accept, multiple: e.multiple })),
    videos: [...body.querySelectorAll('video')].map(e => ({ duration: Number.isFinite(e.duration) ? e.duration : null, width: e.videoWidth, height: e.videoHeight, readyState: e.readyState })) };
}
export async function openBrowser(config, dataDir, { desktop = false, onBlocked = () => {} } = {}) {
  const lock = await acquireProfileLock(dataDir, desktop ? 'manual-account-onboarding' : 'editor-job');
  const navigationDomains = desktop ? [...config.navigationDomains, ...(config.onboardingDomains || [])] : config.navigationDomains;
  let context, currentPhase = desktop ? 'onboarding' : 'read';
  try {
    // Chromium's sandbox is intentionally enabled; never add --no-sandbox.
    context = await chromium.launchPersistentContext(join(dataDir, 'profile'), { headless: false,
      chromiumSandbox: true, acceptDownloads: true, viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block', args: ['--disable-dev-shm-usage'] });
    await context.routeWebSocket('**/*', socket => { onBlocked({url:new URL(socket.url()).origin,method:'WEBSOCKET',navigation:false}); socket.close(); });
    await context.route('**/*', async route => {
      const req = route.request(), navigation = req.isNavigationRequest();
      const request={url:req.url(),method:req.method(),contentType:req.headers()['content-type']||'',body:req.postData()||''};
      if (!allowedUrl(req.url(), navigation ? navigationDomains : [...navigationDomains, ...config.resourceDomains], { navigation }) || !(allowedInteractiveAuth(request,config,desktop) || allowedMutation(request,config.mutationRoutes,currentPhase))) {
        let safe = 'invalid'; try { const u = new URL(req.url()); safe = u.origin + u.pathname.slice(0, 160); } catch {}
        onBlocked({ url: safe, method: req.method(), navigation }); return route.abort('blockedbyclient');
      }
      await route.continue();
    });
    // Auth login may need an explicitly reviewed auth host. No unknown popup can silently gain permissions.
    context.on('page', p => { p.on('framenavigated', f => {
      if (f === p.mainFrame() && f.url() !== 'about:blank' && !allowedUrl(f.url(), navigationDomains, { navigation: true })) void p.close().catch(() => {});
    }); });
    const page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages().slice(1)) await extra.close();
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(30000);
    return { page, context, ownerVersion: lock.version, setPhase: phase => { currentPhase = phase; }, async close() { await context.close().catch(() => {}); await lock.release(); } };
  } catch (e) { await context?.close().catch(() => {}); await lock.release(); throw e; }
}
export class CaptionsAdapter {
  constructor({ session, config, artifactDir, event, signal, choose }) { Object.assign(this, { session, config, artifactDir, event, signal, choose }); this.page = session.page; this.last = null; this.actions = 0; }
  async observe(label = 'observation', screenshot = false) {
    this.signal.throwIfAborted();
    assert(allowedUrl(this.page.url(), this.config.navigationDomains, { navigation: true }), 'unexpected_editor_url');
    const raw = await this.page.locator('body').evaluate(readDom, CONTROLS);
    const snapshot = await this.page.locator('body').ariaSnapshot();
    const digest = createHash('sha256').update(JSON.stringify({ url: this.page.url(), controls: raw.controls, files: raw.files })).digest('hex');
    const o = { id: randomUUID(), version: digest, url: this.page.url(), ownerVersion: this.session.ownerVersion, ...raw, snapshot };
    this.last = o;
    if (screenshot) { const file = `${Date.now()}-${label}.png`; await this.page.screenshot({ path: join(this.artifactDir, file), fullPage: false }); o.screenshot = file; }
    await this.event({ type: 'observation', label, ...o });
    return o;
  }
  checkBarriers(o) {
    if (/verify you are human|captcha|checking your browser|unusual traffic/i.test(o.text)) throw new Stop('browser_security_challenge');
    if (/sign in to|log in to|continue with google|continue with apple|enter your email/i.test(o.text)) throw new Stop('test_account_login_required');
    if (/insufficient credits|not enough credits|upgrade to (?:continue|export|unlock)|subscribe to (?:continue|export|unlock)/i.test(o.text)) throw new Stop('editor_credit_or_subscription_gate');
  }
  async fresh(previous) {
    const now = await this.observe(); this.checkBarriers(now);
    assert(previous.version === now.version && previous.ownerVersion === now.ownerVersion, 'observation_stale'); return now;
  }
  async action(name, previous, fn) {
    this.signal.throwIfAborted(); assert(this.actions < this.config.maxActions, 'action_budget_exceeded');
    await this.fresh(previous); await this.event({ type: 'action_pending', action: name, observation: previous.id, version: previous.version });
    this.actions++; await fn(); await this.event({ type: 'action_dispatched', action: name });
  }
  async select(phase, o) {
    const controls = o.controls.filter(c => permittedControl(c, phase));
    assert(controls.length, `missing_${phase}_control`);
    if (controls.length === 1) return controls[0];
    assert(this.choose, `ambiguous_${phase}_control_typesafe_unconfigured`);
    const candidates = controls.map(c => ({ id: `control_${c.index}`, label: c.label, operation: phase, context: c.context.slice(0, 240) }));
    const choice = await this.choose({ requestedStep: phase, observation: o.id, candidates });
    assert(choice !== 'none', `ambiguous_${phase}_control`);
    const control = controls.find(c => `control_${c.index}` === choice); assert(control, 'model_choice_outside_permitted_candidates'); return control;
  }
  async controlAction(name, phase, o, c, execute) {
    const handle = await this.page.locator(CONTROLS).nth(c.index).elementHandle();
    assert(handle, 'observed_control_detached');
    try {
      await this.action(name, o, async () => {
        const identity = await handle.evaluate(e => ({ connected:e.isConnected,
          label:(e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.getAttribute('placeholder') || e.innerText || e.getAttribute('title') || '').trim().slice(0,180),
          tag:e.tagName.toLowerCase(), disabled:!!e.disabled || e.getAttribute('aria-disabled') === 'true', visible:!!e.getClientRects().length,
          context:(e.closest('[role="dialog"],dialog')?.innerText || '').slice(0,1000) }));
        assert(identity.connected && identity.visible && !identity.disabled && identity.label === c.label && identity.tag === c.tag && !FORBIDDEN.test(identity.context), 'observed_control_changed');
        this.session.setPhase(phase); await execute(handle);
      });
    } finally { await handle.dispose(); }
  }
  async click(phase, o = null) {
    o ||= await this.observe(); this.checkBarriers(o); const c = await this.select(phase, o);
    if (c.href) assert(allowedUrl(new URL(c.href, o.url).href, this.config.navigationDomains, { navigation: true }), 'control_link_not_allowed');
    await this.controlAction(`${phase}:${c.label}`, phase.startsWith('trim') ? 'trim' : phase, o, c, handle => handle.click());
  }
  async waitFor(check, failure, seconds = 15) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      const o = await this.observe(); this.checkBarriers(o); if (check(o)) return o;
      await pause(700, undefined, { signal: this.signal });
    }
    throw new Stop(failure);
  }
  async numeric(labelPattern, value, name) {
    const o = await this.observe(), controls = o.controls.filter(c => c.visible && !c.disabled && ['input'].includes(c.tag) && ['number','text',''].includes(c.type) && labelPattern.test(c.label));
    assert(controls.length === 1, `missing_or_ambiguous_${name}_field`); const c = controls[0];
    await this.controlAction(name, 'trim', o, c, async field => { await field.fill(String(value)); await field.press('Tab'); });
    await this.waitFor(next => next.controls.some(x => x.index === c.index && Number(x.value) === value), `${name}_not_retained`, 4);
  }
  async start() {
    await this.page.goto(this.config.editorUrl, { waitUntil: 'domcontentloaded' });
    const o = await this.observe('source-project', true); this.checkBarriers(o); return o;
  }
  async createProject() {
    const current = await this.observe(); this.checkBarriers(current);
    if (current.files.length === 1 && /^\/(?:home)?\/?$/.test(new URL(current.url).pathname)) return current;
    await this.click('project');
    return this.waitFor(o => o.files.length === 1, 'project_upload_control_not_observed');
  }
  async upload(asset) {
    const o = await this.observe(); assert(o.files.length === 1, 'upload_input_ambiguous');
    const input = await this.page.locator('input[type="file"]').nth(o.files[0].index).elementHandle(); assert(input, 'upload_input_detached');
    try { await this.action('upload_authorized_test_asset', o, async () => { assert(await input.evaluate(e => e.isConnected && e.type === 'file'), 'upload_input_changed'); this.session.setPhase('upload'); await input.setInputFiles(asset.path); }); } finally { await input.dispose(); }
    // Metadata must be loaded, not just a filename or upload-progress toast.
    const ready = await this.waitFor(n => n.videos.some(v => v.readyState >= 1 && v.duration > 0), 'uploaded_video_not_ready', 90);
    await this.observe('uploaded-test-asset', true); return ready;
  }
  async trim(task) {
    await this.click('trim_open');
    await this.numeric(/^(?:Start|Start time|Trim start|In point)$/i, task.trimStart, 'trim_start');
    await this.numeric(/^(?:End|End time|Trim end|Out point)$/i, task.trimEnd, 'trim_end');
    await this.click('trim_apply');
    // Video metadata often remains the original duration in a nonlinear editor. Retained fields are the UI proof;
    // the independent downloaded-file duration check remains mandatory.
    await this.observe('trim-applied', true); return { start: task.trimStart, end: task.trimEnd, method: 'numeric_fields' };
  }
  async captions(task) {
    const o = await this.observe(); this.checkBarriers(o);
    const captionControl = await this.select('captions', o);
    const quote = freeEditEvidence(captionControl.context || captionControl.label);
    assert(!quote.nonzero, 'nonzero_edit_quote_requires_attention');
    assert(quote.included || this.config.includedEditsConfirmed === true, 'included_edit_entitlement_not_confirmed');
    await this.controlAction('captions:' + captionControl.label, 'captions', o, captionControl, handle => handle.click());
    const choices = await this.waitFor(n => n.controls.some(c => c.visible && c.label === task.style), 'caption_style_not_observed');
    const control = choices.controls.filter(c => c.visible && c.label === task.style && !FORBIDDEN.test(c.context));
    assert(control.length === 1, 'caption_style_ambiguous');
    const styleQuote=freeEditEvidence(control[0].context || control[0].label); assert(!styleQuote.nonzero,'nonzero_style_quote_requires_attention');
    await this.controlAction('select_caption_style', 'captions', choices, control[0], handle => handle.click());
    // Wait for actual caption text in the editor; a selected style alone is not completion.
    const phrase = task.expectedCaption.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    await this.waitFor(n => phrase.every(w => n.text.toLowerCase().includes(w)), 'generated_caption_text_not_observed', 180);
    await this.observe('captions-created', true);
  }
  async saveCopy(id) {
    const before = await this.observe(); await this.click('copy', before);
    // Do not invent a project's server ID. A new URL is required for the saved test copy.
    const after = await this.waitFor(o => o.url !== before.url && /project|editor|video/i.test(new URL(o.url).pathname), 'saved_copy_url_not_verified', 30);
    await this.observe('saved-copy', true); return { url: after.url, sourceUrl: before.url, label: `Buena test ${id}` };
  }
  async exportVideo() {
    const o = await this.observe(); this.checkBarriers(o);
    const downloadPromise = this.page.waitForEvent('download', { timeout: 120000 });
    try {
      await this.click('export', o);
      const download = await downloadPromise;
      const reason = await download.failure(); assert(!reason, 'download_failed');
      assert(/\.mp4$/i.test(download.suggestedFilename()), 'export_is_not_mp4');
      const path = join(this.artifactDir, 'export.mp4'); await download.saveAs(path);
      await this.observe('export-complete', true); return path;
    } catch (e) { await downloadPromise.catch(() => {}); throw e; }
  }
}
export async function onboarded(dataDir) {
  try { const marker = JSON.parse(await readFile(join(dataDir, 'test-account.json'), 'utf8')); return marker.profileId === 'captions-test' && (marker.testAccountOnly === true || marker.accountScope === 'owner-authorized') && typeof marker.accountLabel === 'string' && marker.accountLabel.length > 0; }
  catch { return false; }
}
