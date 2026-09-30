import test from 'node:test';
import assert from 'node:assert/strict';
import { consentButtonPatterns, dismissConsent, isConsentScreen, isPostAuthInterstitial } from '../src/login.mjs';

function fakePage({ visible = [], fallbackVisible = false } = {}) {
  const clicks = [];
  const makeLocator = label => ({
    waitFor: async () => {
      if (!visible.includes(label)) throw new Error('not visible');
    },
    click: async () => { clicks.push(label); },
  });
  const page = {
    clicks,
    getByRole(role, { name } = {}) {
      return { first: () => makeLocator(String(name)) };
    },
    locator(selector) {
      return { filter: () => ({ first: () => ({
        waitFor: async () => { if (!fallbackVisible) throw new Error('not visible'); },
        click: async () => { clicks.push('fallback'); },
      }) }) };
    },
  };
  return page;
}

test('the consent screen is recognised only on YouTube with consent text', () => {
  assert.equal(isConsentScreen({ url: 'https://www.youtube.com/', text: 'Before you continue to YouTube ...' }), true);
  assert.equal(isConsentScreen({ url: 'https://www.youtube.com/', text: 'Zanim przejdziesz do YouTube ...' }), true);
  assert.equal(isConsentScreen({ url: 'https://accounts.google.com/', text: 'Before you continue to YouTube' }), false);
  assert.equal(isConsentScreen({ url: 'https://www.youtube.com/', text: 'Sign in Home Shorts' }), false);
  assert.equal(isConsentScreen({ url: 'not a url', text: 'Before you continue' }), false);
});

test('post-auth Google interstitials are recognised and skipped, never filled', () => {
  assert.equal(isPostAuthInterstitial('https://myaccount.google.com/interstitials/birthday'), true);
  assert.equal(isPostAuthInterstitial('https://gds.google.com/web/recoveryoptions'), true);
  assert.equal(isPostAuthInterstitial('https://gds.google.com/web/landing'), true);
  assert.equal(isPostAuthInterstitial('https://www.youtube.com/'), false);
  assert.equal(isPostAuthInterstitial('https://accounts.google.com/v3/signin/identifier'), false);
  assert.equal(isPostAuthInterstitial('not a url'), false);
});

test('consent dismissal clicks Reject all first, then falls back to Accept all', async () => {
  const rejectFirst = fakePage({ visible: [String(consentButtonPatterns[0])] });
  assert.equal(await dismissConsent(rejectFirst), true);
  assert.deepEqual(rejectFirst.clicks, [String(consentButtonPatterns[0])]);

  const acceptOnly = fakePage({ visible: [String(consentButtonPatterns[1])] });
  assert.equal(await dismissConsent(acceptOnly), true);
  assert.deepEqual(acceptOnly.clicks, [String(consentButtonPatterns[1])]);
});

test('consent dismissal falls back to the dialog container and otherwise reports failure', async () => {
  const container = fakePage({ fallbackVisible: true });
  assert.equal(await dismissConsent(container), true);
  assert.deepEqual(container.clicks, ['fallback']);

  const none = fakePage();
  assert.equal(await dismissConsent(none), false);
  assert.equal(none.clicks.length, 0);
});
