import { createHash, createHmac } from 'node:crypto';

export class PilotError extends Error {
  constructor(code) { super(code); this.name = 'PilotError'; this.code = code; }
}
export function requireThat(condition, code) { if (!condition) throw new PilotError(code); }
export function errorCode(error) { return error instanceof PilotError ? error.code : 'unexpected_error'; }
export function accountId(account) {
  return createHash('sha256').update(`${account.platform}:${account.username.toLowerCase()}`).digest('hex').slice(0, 20);
}

export function parseTotp(value) {
  requireThat(typeof value === 'string', 'invalid_totp_secret');
  let secret = value, algorithm = 'sha1', digits = 6, period = 30;
  if (value.startsWith('otpauth://')) {
    let url;
    try { url = new URL(value); } catch { throw new PilotError('invalid_totp_uri'); }
    requireThat(url.hostname === 'totp', 'unsupported_otp_type');
    secret = url.searchParams.get('secret') || '';
    algorithm = (url.searchParams.get('algorithm') || 'SHA1').toLowerCase();
    digits = Number(url.searchParams.get('digits') || 6);
    period = Number(url.searchParams.get('period') || 30);
  }
  secret = secret.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  requireThat(/^[A-Z2-7]{16,256}$/.test(secret), 'invalid_totp_secret');
  requireThat(['sha1', 'sha256', 'sha512'].includes(algorithm) && [6, 8].includes(digits)
    && Number.isInteger(period) && period >= 15 && period <= 120, 'unsupported_totp_parameters');
  let bits = 0, buffer = 0; const bytes = [];
  for (const char of secret) {
    buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
  }
  requireThat(bits === 0 || (buffer & ((1 << bits) - 1)) === 0, 'invalid_totp_padding');
  return { key: Buffer.from(bytes), algorithm, digits, period };
}
export function totp(value, now = Date.now()) {
  const settings = parseTotp(value);
  requireThat(Number.isFinite(now) && now >= 0, 'invalid_clock');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / settings.period)));
  const digest = createHmac(settings.algorithm, settings.key).update(counter).digest();
  const offset = digest.at(-1) & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** settings.digits);
  return { code: String(number).padStart(settings.digits, '0'),
    validForMs: settings.period * 1000 - (now % (settings.period * 1000)) };
}

function splitRow(line) {
  const values = []; let field = '', quoted = false, closed = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) { quoted = false; closed = true; }
      else { requireThat(field === '' && !closed, 'invalid_delimited_record'); quoted = true; }
    } else if (char === ';' && !quoted) { values.push(field); field = ''; closed = false; }
    else { requireThat(!closed, 'invalid_delimited_record'); field += char; }
  }
  requireThat(!quoted, 'invalid_delimited_record'); values.push(field); return values;
}
export function parseAccounts(text, platform) {
  let records;
  if (text.trimStart().startsWith('[')) {
    try { records = JSON.parse(text); } catch { throw new PilotError('invalid_accounts_json'); }
  } else {
    requireThat(['instagram', 'youtube'].includes(platform), 'platform_required_for_delimited_import');
    records = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => {
      const row = splitRow(line);
      requireThat(row.length === 3, 'expected_username_password_totp_columns');
      return { platform, username: row[0], password: row[1], totp: row[2] || undefined };
    });
  }
  requireThat(Array.isArray(records) && records.length > 0, 'empty_account_import');
  const ids = new Set(); const bindings = new Set();
  return records.map(record => {
    requireThat(record && ['instagram', 'youtube'].includes(record.platform), 'unsupported_platform');
    requireThat(typeof record.username === 'string' && record.username.length <= 254
      && record.username.trim() === record.username && !/[\s<>]/.test(record.username), 'invalid_username');
    requireThat(record.platform !== 'instagram' || /^[\w.]{1,64}$/.test(record.username), 'invalid_instagram_username');
    requireThat(record.platform !== 'youtube' || /^[^@]+@[^@]+\.[^@]+$/.test(record.username), 'google_email_required');
    requireThat(typeof record.password === 'string' && record.password.length > 0
      && record.password.length <= 1024 && !/[\r\n\x00]/.test(record.password), 'invalid_password');
    if (record.totp) parseTotp(record.totp);
    requireThat(record.recoveryEmail === undefined || (typeof record.recoveryEmail === 'string'
      && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.recoveryEmail)), 'invalid_recovery_email');
    const account = { platform: record.platform, username: record.username, password: record.password,
      ...(record.totp ? { totp: record.totp } : {}), ...(record.recoveryEmail ? { recoveryEmail: record.recoveryEmail } : {}) };
    if (record.characterId !== undefined) {
      requireThat(typeof record.characterId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(record.characterId), 'invalid_character_id');
      const binding = `${record.characterId}:${record.platform}`;
      requireThat(!bindings.has(binding), 'duplicate_character_platform'); bindings.add(binding);
      account.characterId = record.characterId;
    }
    if (record.proxyCountry !== undefined) {
      requireThat(typeof record.proxyCountry === 'string' && /^[a-z]{2}$/.test(record.proxyCountry), 'invalid_proxy_country');
      account.proxyCountry = record.proxyCountry;
    }
    account.id = accountId(account);
    requireThat(!ids.has(account.id), 'duplicate_account'); ids.add(account.id); return account;
  });
}

export function createRedactor(secrets = []) {
  const values = new Set(secrets.filter(value => typeof value === 'string' && value));
  const redact = value => {
    let output = String(value ?? '');
    for (const secret of [...values].sort((a, b) => b.length - a.length)) output = output.split(secret).join('[secret]');
    return output.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/\b\d{6,8}\b/g, '[code]');
  };
  redact.add = value => values.add(value);
  return redact;
}
export function failurePolicy(code) {
  // Google's rejected sign-in can be network-reputation related; the operator
  // policy is one proxy refresh and retry, bounded by maxProxySwitches.
  const transport = ['proxy_connection_failed', 'tunnel_failed', 'dns_failed', 'connection_reset', 'connection_timed_out', 'signin_rejected'];
  return { rotateProxy: transport.includes(code),
    needsAttention: !transport.includes(code), retryCredentials: false };
}
export function navigationError(error) {
  const message = String(error?.message || '');
  for (const [match, code] of [
    ['ERR_PROXY_CONNECTION_FAILED', 'proxy_connection_failed'], ['ERR_TUNNEL_CONNECTION_FAILED', 'tunnel_failed'],
    ['ERR_NAME_NOT_RESOLVED', 'dns_failed'], ['ERR_CONNECTION_RESET', 'connection_reset'],
    ['ERR_CONNECTION_TIMED_OUT', 'connection_timed_out'], ['ERR_TIMED_OUT', 'connection_timed_out'],
  ]) if (message.includes(match)) return new PilotError(code);
  return new PilotError(/Timeout/i.test(message) ? 'page_load_timeout' : 'navigation_failed');
}
