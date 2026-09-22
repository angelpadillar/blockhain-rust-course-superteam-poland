import { requireThat } from './core.mjs';
import { acquireProfileLock } from './profile-lock.mjs';
import { connect as defaultConnect, stopBrowserProfile } from './runner.mjs';
import { observationFromSnapshot } from './observation.mjs';

// The snapshot adapter lives in observation.mjs so the login executor can reach
// it without importing this provider (which reaches the runner). It stays
// exported here: this is the provider's public surface.
export { observationFromSnapshot };

// Provider seam: an ALREADY-RUNNING browser session, independent of where the
// browser came from. This wraps the existing profile lifecycle and the existing
// Playwright attachment; it never launches a browser of its own.
//
//   resolve profile -> ownership lock -> launcher start -> returned CDP port
//     -> connectOverCDP -> browser.contexts()[0] -> existing session ownership
//     -> graceful Chromium close -> Multilogin stop/sync
export class MultiloginSessionProvider {
  constructor({ api, config, profileId = null, directory = null, connectImpl = defaultConnect,
    lock = null, importer = null, lockDetails = {} } = {}) {
    requireThat(api && typeof api.start === 'function', 'provider_api_required');
    requireThat(config && config.folderId, 'provider_config_required');
    requireThat(profileId === null || (typeof profileId === 'string' && profileId.length >= 8),
      'invalid_multilogin_id');
    this.api = api; this.config = config; this.profileId = profileId;
    this.directory = directory; this.connectOverCDP = connectImpl;
    this.acquire = lock || acquireProfileLock;
    // Extra fields recorded in the ownership lock (jobId, platform, ...).
    this.lockDetails = lockDetails;
    this.session = null; this.release = null; this.port = null; this.lockHeld = false;
  }

  // The job layer may not know the profile id until the record layer has resolved
  // or created the profile, so the id is bound before any lifecycle call.
  bindProfileId(profileId) {
    requireThat(typeof profileId === 'string' && profileId.length >= 8, 'invalid_multilogin_id');
    requireThat(!this.session && !this.port, 'profile_id_change_requires_idle_provider');
    this.profileId = profileId;
    return this;
  }

  // Take exclusive ownership of the profile without starting it: the job layer
  // locks first, the record layer starts later. One owner, one lock.
  // The lock is keyed by the profile REFERENCE, so ownership can be taken before
  // the record layer knows which profile id the reference maps to.
  async claimOwnership({ profileRef = null, accountId = null } = {}) {
    if (this.lockHeld) return { profileId: this.profileId, owned: true };
    // Without a state directory and a profile reference there is no ownership to
    // take: the caller already owns the session.
    if (!this.directory || !profileRef) return { profileId: this.profileId, owned: false };
    this.release = await this.acquire(this.directory, profileRef,
      { accountId, profileId: this.profileId ?? null, ...this.lockDetails });
    this.lockHeld = true;
    return { profileId: this.profileId, owned: true };
  }

  // Start the SAME profile and learn the launcher-returned CDP port. Nothing is
  // launched here: the launcher owns the browser.
  async start() {
    requireThat(this.profileId, 'provider_profile_id_required');
    const port = await this.api.start(this.config.folderId, this.profileId, this.config.headless === true);
    requireThat(Number.isInteger(port) && port > 0, 'invalid_browser_port');
    this.port = port;
    return port;
  }

  // Attach to the endpoint the launcher returned, reusing the EXISTING context.
  // The existing connect() performs chromium.connectOverCDP and reuses
  // browser.contexts()[0]; we add nothing and launch nothing.
  async connect() {
    requireThat(Number.isInteger(this.port) && this.port > 0, 'invalid_browser_port');
    let partial = null;
    try {
      partial = await this.connectOverCDP(this.port, this.config);
      requireThat(partial?.browser && partial?.context && partial?.page, 'provider_session_incomplete');
      this.session = { ...partial, port: this.port, profileId: this.profileId };
      return this.session;
    } catch (error) {
      // The profile was started, so it is stopped even though attaching failed.
      await stopBrowserProfile(this.api, this.profileId, partial?.browser).catch(() => {});
      this.port = null;
      throw error;
    }
  }

  // Start and attach again inside the same ownership: a proxy switch or a
  // restart verification during one job.
  async resume() { await this.start(); return this.connect(); }

  // Attachment is idempotent: a second attach returns the same live session
  // rather than starting anything.
  async attach({ profileRef = null, accountId = null } = {}) {
    if (this.session) return this.session;
    await this.claimOwnership({ profileRef, accountId });
    try {
      return await this.resume();
    } catch (error) {
      await this.detach().catch(() => {});
      throw error;
    }
  }

  // Graceful stop: Chromium flushed, then Multilogin stop/sync, KEEPING ownership
  // (the job still owns the profile between cycles).
  async suspend() {
    const session = this.session;
    this.session = null;
    if (session) await stopBrowserProfile(this.api, this.profileId, session.browser);
    this.port = null;
    return { profileId: this.profileId, stopped: Boolean(session) };
  }

  // Graceful path only: Chromium flushed, then Multilogin stop/sync, then the
  // ownership lock. No profile is ever deleted or recreated here.
  async detach() {
    try { await this.suspend(); }
    finally {
      if (this.release) { const release = this.release; this.release = null; this.lockHeld = false; await release().catch(() => {}); }
    }
    return { profileId: this.profileId, stopped: true };
  }
}

export const defaultSiteFor = platform => platform;

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
