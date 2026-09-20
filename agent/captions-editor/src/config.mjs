import path from 'node:path';

export const UPSTREAM_VERSION = '0.1.29';
export const SESSION_ID = 'captions-manual';
export const INTERNAL_PORT = 8793;
export function validateConfig(input) {
  const permitted = new Set(['initialUrl', 'stateDir', 'allowedHosts', 'resumeJobId']);
  if (!input || Object.keys(input).some(key => !permitted.has(key))) throw new Error('Unknown candidate configuration field');
  if (input.resumeJobId !== undefined && !/^[a-zA-Z0-9_-]{1,80}$/.test(input.resumeJobId)) throw new Error('Invalid resume job identifier');
  if (input.initialUrl !== 'https://captions.ai/home') throw new Error('Only the Captions home page may be opened automatically');
  if (!path.isAbsolute(input.stateDir || '')) throw new Error('stateDir must be absolute');
  if (!Array.isArray(input.allowedHosts) || !input.allowedHosts.length || input.allowedHosts.length > 40) throw new Error('Explicit reviewed hosts required');
  for (const host of input.allowedHosts) {
    if (typeof host !== 'string' || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) throw new Error('Hosts must be exact public DNS names, without wildcards, ports, or credentials');
  }
  if (!input.allowedHosts.includes('captions.ai')) throw new Error('Captions host is missing');
  return Object.freeze({ ...input, allowedHosts: Object.freeze([...new Set(input.allowedHosts)]) });
}
export function onboardingArgs(config, { automation = false } = {}) {
  return ['mcp', '--transport', 'stdio', '--toolset', automation ? 'full' : 'core', '--session-dir', config.stateDir,
    '--allowed-hosts', config.allowedHosts.join(','), '--max-sessions', '1', '--session-ttl', '24h',
    ...(automation ? ['--allow-file-upload', '--allow-file-download'] : [])];
}
export function fixtureArgs(stateDir) {
  return ['mcp', '--transport', 'stdio', '--toolset', 'full', '--session-dir', stateDir,
    '--allowed-hosts', '127.0.0.1', '--allow-localhost', '--allow-file-upload', '--allow-file-download',
    '--max-sessions', '1', '--session-ttl', '10m'];
}
