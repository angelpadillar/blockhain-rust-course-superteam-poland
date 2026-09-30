import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVerificationCode, platformMatches, readOutlookVerificationCode } from '../src/mailbox-code.mjs';
import { createValueResolver } from '../src/secrets.mjs';

test('a code is extracted from the platform email, not from unrelated numbers', () => {
  assert.equal(extractVerificationCode('LinkedIn: Your verification code is 123456. Do not share it.'), '123456');
  assert.equal(extractVerificationCode('Use 654321 to confirm your email address.'), '654321');
  assert.equal(extractVerificationCode('Your order 2026 was shipped, tracking 1234567890'), null);
  assert.equal(extractVerificationCode('LinkedIn security alert for your account.'), null);
  // Two standalone six-digit numbers are ambiguous and refused.
  assert.equal(extractVerificationCode('LinkedIn codes 111111 and 222222', { platform: 'linkedin' }), null);
  assert.equal(extractVerificationCode('LinkedIn code 333333', { platform: 'linkedin' }), '333333');
  assert.equal(platformMatches('LinkedIn <security-noreply@linkedin.com>', 'linkedin'), true);
  assert.equal(platformMatches('Your Amazon order', 'linkedin'), false);
});

test('the resolver accepts a mailbox code for this run only', async () => {
  const resolver = createValueResolver({ account: { username: 'a@b.com', password: 'x' } });
  assert.equal(resolver.verificationCodeAvailable(), false);
  await assert.rejects(resolver.resolve('verification_code'), /verification_code_unavailable/);
  resolver.setVerificationCode('445566');
  assert.equal(resolver.verificationCodeAvailable(), true);
  assert.equal(await resolver.resolve('verification_code'), '445566');
});

test('the mailbox reader opens the inbox, finds the newest matching mail and closes the tab', async () => {
  const results = [
    ['LinkedIn <security-noreply@linkedin.com> LinkedIn verification code'],
    ['LinkedIn <security-noreply@linkedin.com> LinkedIn verification code'],
  ];
  const calls = { goto: [], closed: false };
  let call = 0;
  const page = {
    async goto(url) { calls.goto.push(url); },
    async waitForTimeout() {},
    async evaluate() { call++; if (call === 1) return results[0]; if (call === 2) return undefined;
      return 'Your LinkedIn verification code is 778899'; },
    async close() { calls.closed = true; },
  };
  const context = { async newPage() { return page; } };
  const result = await readOutlookVerificationCode({ context, platform: 'linkedin', timeoutMs: 5000, pollMs: 1 });
  assert.equal(result.code, '778899');
  assert.equal(calls.goto[0], 'https://outlook.live.com/mail/0/');
  assert.equal(calls.closed, true);
  const missing = await readOutlookVerificationCode({ context: {}, platform: 'linkedin' });
  assert.equal(missing.code, null);
  assert.equal(missing.reason, 'context_unavailable');
});
