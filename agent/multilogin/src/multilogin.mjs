import { PilotError, requireThat } from './core.mjs';

const idPattern = /^[a-zA-Z0-9-]{8,80}$/;
function id(value) { requireThat(typeof value === 'string' && idPattern.test(value), 'invalid_multilogin_id'); return value; }
export class Multilogin {
  constructor({ token, launcherUrl = 'https://launcher.mlx.yt:45001', fetchImpl = fetch }) {
    requireThat(typeof token === 'string' && token.length > 10, 'missing_multilogin_token');
    const url = new URL(launcherUrl);
    requireThat(!url.username && !url.password && (url.protocol === 'https:'
      || (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))), 'invalid_launcher_url');
    this.token = token; this.launcher = url.origin; this.fetch = fetchImpl;
  }
  async request(base, path, body, timeoutMs = 30000) {
    let response;
    try {
      response = await this.fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new PilotError('multilogin_request_uncertain'); }
    if (!response.ok) {
      const error = new PilotError(`multilogin_http_${response.status}`);
      try {
        const body = await response.json(); const code = body.status?.error_code;
        if (typeof code === 'string' && /^[A-Z0-9_]{1,100}$/.test(code)) error.vendorCode = code;
        if (path.startsWith('/api/v1/profile/stop/p/') && response.status === 500
          && code === 'INTERNAL_SERVER_ERROR' && /^profile(?: [a-f0-9-]+)? already stopped$/i.test(body.status?.message || '')) {
          error.code = 'profile_already_stopped'; error.message = error.code;
        }
      } catch {}
      throw error;
    }
    let result;
    try { result = await response.json(); } catch { throw new PilotError('multilogin_invalid_response'); }
    requireThat(!result.status?.error_code && (!result.status?.http_code || result.status.http_code < 400), 'multilogin_api_error');
    return result.data;
  }
  cloud(path, body) { return this.request('https://api.multilogin.com', path, body); }
  folders() { return this.cloud('/workspace/folders'); }
  automationToken() { return this.cloud('/workspace/automation_token?expiration_period=1mo'); }
  async premiumProxy(country) {
    requireThat(typeof country === 'string' && /^[a-z]{2}$/.test(country), 'proxy_country_required');
    const data = await this.cloud(`/proxynm/connection_url?country=${country}&protocol=socks5&session_type=sticky&count=1`);
    requireThat(data?.connection_urls?.length === 1, 'proxy_generation_invalid_response');
    const parts = /^([^:]+):(\d+):([^:]+):(.+)$/.exec(data.connection_urls[0]);
    requireThat(parts, 'proxy_generation_invalid_response');
    const proxy = { type: 'socks5', host: parts[1], port: Number(parts[2]), username: parts[3], password: parts[4] };
    resolveProxy(proxy); return proxy;
  }
  async create({ name, folderId, osType, cloudStorage, proxy }) {
    const result = await this.cloud('/profile/create', { name, folder_id: id(folderId), browser_type: 'mimic',
      os_type: osType, times: 1, auto_update_core: true,
      parameters: { storage: { is_local: !cloudStorage, save_service_worker: true },
        flags: { proxy_masking: proxy ? 'custom' : 'disabled' }, ...(proxy ? { proxy } : {}) } });
    requireThat(Array.isArray(result?.ids) && result.ids.length === 1, 'profile_create_result_unknown');
    return id(result.ids[0]);
  }
  async start(folderId, profileId, headless) {
    let result;
    try {
      result = await this.request(this.launcher,
        `/api/v2/profile/f/${id(folderId)}/p/${id(profileId)}/start?automation_type=playwright&headless_mode=${!!headless}`,
        undefined, 90000);
    } catch (error) {
      if (error.code === 'multilogin_http_400') {
        const status = await this.status(profileId).catch(() => null);
        if (status?.status === 'validate_proxy_error') {
          const failure = new PilotError('proxy_connection_failed'); failure.lifecycleStopped = true; throw failure;
        }
      }
      throw error;
    }
    const port = Number(result?.port);
    requireThat(Number.isInteger(port) && port > 0 && port <= 65535, 'invalid_browser_port');
    requireThat(!result.browser_type || result.browser_type === 'mimic', 'unsupported_browser_type');
    return port;
  }
  async stop(profileId) {
    try { return await this.request(this.launcher, `/api/v1/profile/stop/p/${id(profileId)}`, undefined, 90000); }
    catch (error) { if (error.code === 'profile_already_stopped') return { alreadyStopped: true }; throw error; }
  }
  status(profileId) { return this.request(this.launcher, `/api/v1/profile/status/p/${id(profileId)}`); }
  // Read-only profile metadata. Used by reuse-existing-proxy mode to prove a
  // proxy is already attached before anything is started; it never prints or
  // returns proxy credentials.
  async profileMeta(profileId) {
    const data = await this.cloud('/profile/metas', { ids: [id(profileId)] });
    return data?.profiles?.find(profile => profile.id === profileId) || null;
  }
  // Rename/metadata update that must carry the profile's own parameters back
  // unchanged. The caller (profile-labels.mjs) re-reads and verifies that the
  // fingerprint/proxy/session configuration did not move.
  updateProfile({ profileId, name, autoUpdateCore, parameters }) {
    requireThat(typeof name === 'string' && name.length > 0 && name.length <= 120, 'invalid_profile_name');
    requireThat(parameters && typeof parameters === 'object', 'profile_parameters_required');
    return this.cloud('/profile/update', { profile_id: id(profileId), name,
      auto_update_core: autoUpdateCore === true, parameters });
  }
  async changeProxy(profileId, proxy) {
    const data = await this.cloud('/profile/metas', { ids: [id(profileId)] });
    const meta = data?.profiles?.find(profile => profile.id === profileId);
    requireThat(meta?.parameters?.flags && meta.parameters.storage && meta.name, 'profile_metadata_missing');
    requireThat(!meta.in_use_by, 'profile_still_in_use');
    requireThat(typeof meta.is_auto_update === 'boolean', 'profile_update_mode_unknown');
    // Preserve the observed profile configuration and update only proxy-related fields.
    return this.cloud('/profile/update', { profile_id: profileId, name: meta.name,
      auto_update_core: meta.is_auto_update,
      parameters: { ...meta.parameters, flags: { ...meta.parameters.flags, proxy_masking: 'custom' }, proxy } });
  }
}

export function resolveProxy(item, environment = process.env) {
  if (!item) return undefined;
  requireThat(['http', 'https', 'socks5'].includes(item.type) && typeof item.host === 'string'
    && /^[a-zA-Z0-9.-]+$/.test(item.host) && Number.isInteger(item.port) && item.port > 0 && item.port <= 65535,
  'invalid_proxy_configuration');
  const result = { type: item.type, host: item.host, port: item.port };
  for (const key of ['username', 'password']) {
    if (item[`${key}Env`]) {
      const value = environment[item[`${key}Env`]];
      requireThat(typeof value === 'string' && value, 'missing_proxy_secret'); result[key] = value;
    }
  }
  return result;
}
