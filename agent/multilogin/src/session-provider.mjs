import { requireThat } from './core.mjs';
import { acquireProfileLock } from './profile-lock.mjs';
import { connect as defaultConnect, stopBrowserProfile } from './runner.mjs';
import { createObservation } from './contract.mjs';

// Provider seam: an ALREADY-RUNNING browser session, independent of where the
// browser came from. This wraps the existing profile lifecycle and the existing
// Playwright attachment; it never launches a browser of its own.
//
//   resolve profile -> ownership lock -> launcher start -> returned CDP port
//     -> connectOverCDP -> browser.contexts()[0] -> existing session ownership
//     -> graceful Chromium close -> Multilogin stop/sync
export class MultiloginSessionProvider {
  constructor({ api, config, profileId, directory = null, connectImpl = defaultConnect,
    lock = null, importer = null } = {}) {
    requireThat(api && typeof api.start === 'function', 'provider_api_required');
    requireThat(config && config.folderId, 'provider_config_required');
    requireThat(typeof profileId === 'string' && profileId.length >= 8, 'invalid_multilogin_id');
    this.api = api; this.config = config; this.profileId = profileId;
    this.directory = directory; this.connect = connectImpl;
    this.acquire = lock || acquireProfileLock;
    this.session = null; this.release = null; this.port = null; this.lockHeld = false;
  }

  // Attachment is idempotent: a second attach returns the same live session
  // rather than starting anything.
  async attach({ profileRef = null, accountId = null } = {}) {
    if (this.session) return this.session;
    if (this.directory && profileRef) {
      this.release = await this.acquire(this.directory, profileRef, { accountId, profileId: this.profileId });
      this.lockHeld = true;
    }
    try {
      this.port = await this.api.start(this.config.folderId, this.profileId, this.config.headless === true);
      requireThat(Number.isInteger(this.port) && this.port > 0, 'invalid_browser_port');
      // The existing connect() performs chromium.connectOverCDP and reuses
      // browser.contexts()[0]; we add nothing and launch nothing.
      const session = await this.connect(this.port, this.config);
      requireThat(session?.browser && session?.context && session?.page, 'provider_session_incomplete');
      this.session = { ...session, port: this.port, profileId: this.profileId };
      return this.session;
    } catch (error) {
      await this.detach().catch(() => {});
      throw error;
    }
  }

  // Graceful path only: Chromium flushed, then Multilogin stop/sync, then the
  // ownership lock. No profile is ever deleted or recreated here.
  async detach() {
    const session = this.session;
    this.session = null;
    try {
      if (session) await stopBrowserProfile(this.api, this.profileId, session.browser);
    } finally {
      if (this.release) { const release = this.release; this.release = null; this.lockHeld = false; await release().catch(() => {}); }
      this.port = null;
    }
    return { profileId: this.profileId, stopped: true };
  }
}

export const defaultSiteFor = platform => platform;

// Maps an existing login-pilot snapshot into the shared observation contract.
// Control ids are epoch-scoped: they are only valid with the epoch returned here.
export function observationFromSnapshot({ snapshot, platform = 'youtube', ttlMs = 15000, now = Date.now() }) {
  const controls = snapshot.controls.map((control, index) => ({
    id: `e${index}`,
    signature: control.key,
    role: control.role || control.tag,
    name: control.label || control.name || '',
    enabled: control.enabled === true,
    visible: true,
    inputType: control.type || null,
    autocomplete: control.autocomplete || null,
  }));
  return createObservation({ url: snapshot.url, text: snapshot.text, controls, ttlMs, now });
}

// Facade implementing the shared session surface over the existing LoginBrowser.
export function sessionTools({ session, platform = 'youtube', LoginBrowserImpl, siteFor = defaultSiteFor }) {
  const browser = new LoginBrowserImpl(session.page, { platform, username: '', password: '', totp: '' },
    { site: siteFor(platform) });
  return {
    getUrl: async () => { const parsed = new URL(session.page.url()); return { origin: parsed.origin, pathname: parsed.pathname }; },
    observe: async ({ ttlMs = 15000 } = {}) => observationFromSnapshot({ snapshot: await browser.observe(), platform, ttlMs }),
    candidates: snapshot => browser.candidates(snapshot),
    execute: (action, snapshot) => browser.execute(action, snapshot),
    screenshot: async options => browser.screenshot(options),
    port: session.port,
    profileId: session.profileId,
  };
}
