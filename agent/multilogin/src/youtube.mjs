import { navigate, classifyPage, verifyIdentity, sites } from './login.mjs';

export const studioUrl = 'https://studio.youtube.com/';
export const studioOrigin = 'https://studio.youtube.com';
// The signed-in Studio top bar has changed shape repeatedly; candidates are
// tried in order and an unknown layout reports a state instead of guessing.
const channelSelectors = ['#channel-name', 'ytcp-entity-page-header #channel-name',
  'ytcp-channel-header #channel-name', 'ytcp-avatar', '#avatar-btn'];

// The same public evidence shape the login observer produces, so classifyPage
// and the checkpoint wait can be reused unchanged on Studio.
export async function observeStudio(page) {
  const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 14000);
  const challengeFrame = await page.locator('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"]')
    .count().catch(() => 0) > 0;
  return { url: page.url(), text, controls: [], challengeFrame };
}

export function studioPath(url) {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return null; }
}

async function readChannel(page) {
  for (const selector of channelSelectors) {
    const locator = page.locator(selector).first();
    const count = await locator.count().catch(() => 0);
    if (!count) continue;
    const text = (await locator.innerText({ timeout: 2000 }).catch(() => '') || '').replace(/\s+/g, ' ').trim();
    if (text && !/^(create a channel|utwórz kanał)$/i.test(text)) return { name: text.slice(0, 120), source: selector };
  }
  return null;
}

// Signs nothing in and clicks nothing. It reports what the authenticated Studio
// session shows: an account/channel state, a checkpoint, or a signed-out state.
export async function inspectStudio({ page, account, onStep = async () => {} }) {
  await navigate(page, studioUrl);
  const snapshot = await observeStudio(page);
  const path = studioPath(snapshot.url);
  const failure = classifyPage(snapshot);
  if (failure) {
    const state = failure === 'human_verification_required' || snapshot.challengeFrame ? 'checkpoint' : 'signed_out';
    await onStep({ phase: 'youtube_studio', state, reason: failure });
    return { authenticated: false, state, reason: failure, url: path, channel: null };
  }
  if (new URL(snapshot.url).origin !== studioOrigin) {
    await onStep({ phase: 'youtube_studio', state: 'signed_out', reason: 'studio_sign_in_required' });
    return { authenticated: false, state: 'signed_out', reason: 'studio_sign_in_required', url: path, channel: null };
  }
  const channel = await readChannel(page);
  const state = channel ? 'ready' : /create a channel|utwórz kanał/i.test(snapshot.text) ? 'no_channel' : 'unknown';
  await onStep({ phase: 'youtube_studio', state, channel: channel ? { name: channel.name } : null });
  return { authenticated: true, state, reason: null, url: path, channel,
    verifiedIdentity: verifyIdentity(account, snapshot, sites.youtube) };
}
