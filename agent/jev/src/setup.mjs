import { createHash } from 'node:crypto';
import { assert, normalize } from './config.mjs';
import { isCheckout, allowedUrl } from './policy.mjs';

export function verifySetupObservation(observation, config = null) {
  assert(!isCheckout(observation.url), 'setup_checkout_open');
  assert(!observation.blocked, 'setup_browser_challenge');
  assert(observation.destinationVerified, 'setup_address_mismatch');
  if (config?.expectedAccountLabel) {
    // Account onboarding can finish on a Glovo listing page. Only an explicit
    // visible account label is accepted; absence of a login prompt is insufficient.
    assert(observation.controls.some(c => c.tag === 'button'
      && normalize(c.label) === normalize(config.expectedAccountLabel)), 'setup_login_required');
    if (observation.cartKnown) assert(observation.cart.length === 0, 'setup_cart_not_empty');
    return { accountVerified: true, basketVerifiedEmpty: observation.cartKnown && observation.cart.length === 0,
      storeReady: allowedUrl(observation.url, config) && observation.cartKnown && observation.cart.length === 0 && !observation.unavailable };
  }
  assert(!observation.unavailable, 'setup_store_unavailable');
  assert(observation.cartKnown, 'setup_cart_unreadable');
  assert(observation.cart.length === 0, 'setup_cart_not_empty');
  return { accountVerified: false, basketVerifiedEmpty: true, storeReady: !observation.unavailable };
}

export const setupPolicyDigest = config => createHash('sha256').update(JSON.stringify({
  storeUrl: config.storeUrl, destinationLabel: config.destinationLabel,
  expectedAddress: normalize(config.expectedAddress), expectedAccountLabel: config.expectedAccountLabel || null,
})).digest('hex');

export function setupErrorMessage(error) {
  const messages = {
    outside_configured_store: 'The browser is on a different page. Open the configured store in the remote browser, then retry. If you chose another store, its configuration needs updating first.',
    outside_setup_pages: 'Open a Glovo store or category page for Kraków in the remote browser, then retry.',
    setup_login_required: 'The expected signed-in account is not visible. Sign into Glovo and return to a store or category page, then retry.',
    setup_address_mismatch: 'The delivery address shown in Glovo differs from the address configured for this test. Update the test configuration to your intended address, then retry.',
    setup_store_unavailable: 'This store is currently unavailable at the selected address. Choose an available store and update the test configuration before retrying.',
    setup_cart_unreadable: 'The empty basket cannot be verified on this page. Open the configured store and wait for its basket to load, then retry.',
    setup_cart_not_empty: 'The basket still contains products. Empty it in the remote browser, then retry. Nothing has been removed automatically.',
    setup_checkout_open: 'The browser is at checkout. Return to the configured store and empty the basket before finishing setup.',
    setup_browser_challenge: 'Glovo is asking for a browser verification. Complete it manually in the remote browser, then retry.',
  };
  return messages[error?.code] || 'The browser could not be checked. Return to the setup page and retry; if the browser was closed, restart onboarding.';
}

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function setupPage(config, nonce, errorMessage = null) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Finish Glovo setup</title><main>
<h1>Finish Glovo setup</h1>
${errorMessage ? `<p role="alert">${escapeHtml(errorMessage)}</p>` : ''}
<p>Sign into Glovo in the remote browser and select the delivery address below. You can finish from a store or category page when the expected account name is visible.</p>
<dl><dt>Test destination</dt><dd>${escapeHtml(config.destinationLabel)}</dd><dt>Expected street and number</dt><dd>${escapeHtml(config.expectedAddress)}</dd><dt>Configured store</dt><dd>${escapeHtml(config.merchant)}</dd></dl>
${config.expectedAccountLabel ? `<p>Expected account name: ${escapeHtml(config.expectedAccountLabel)}</p>` : '<p>For this configuration, open the configured store and leave its basket empty before finishing.</p>'}
<p>This saves account setup. Each shopping job separately checks store availability, the delivery address and an empty basket before starting. No purchase is made.</p>
<form method="POST" action="/finish?token=${escapeHtml(nonce)}"><button>Verify setup and close browser</button></form>
</main></html>`;
}
