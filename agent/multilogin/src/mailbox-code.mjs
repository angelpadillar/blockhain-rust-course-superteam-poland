// Read a platform's verification code from the account's OWN mailbox, using the
// Microsoft session already established in the same Multilogin profile. It is
// read-only: it opens the inbox in a temporary tab, reads the newest matching
// message, extracts the code and closes the tab. It never clicks a link, never
// sends or deletes mail and never prints the code.
export const codePatterns = [
  /(?:code|kod|pin)\D{0,40}(\d{6})(?!\d)/i,
  /(\d{6})(?!\d)\D{0,30}(?:code|kod|pin|verify|confirm|verification)/i,
  /(?:verify|confirm|verification|zweryfikuj|potwierdź)\D{0,60}(\d{6})(?!\d)/i,
];

export function extractVerificationCode(text, { platform = null } = {}) {
  const value = String(text || '').replace(/\s+/g, ' ');
  // Never guess between two codes: an email with more than one standalone
  // six-digit number is ambiguous and falls back to a person.
  const six = [...new Set(value.match(/(?<!\d)(\d{6})(?!\d)/g) || [])];
  if (six.length !== 1) return null;
  const keyword = /(?:code|kod|pin|verify|confirm|verification|zweryfikuj|potwierdź)/i.test(value);
  const named = platform ? new RegExp(platform, 'i').test(value) : false;
  return keyword || named ? six[0] : null;
}

export function platformMatches(text, platform) {
  if (!platform) return true;
  const aliases = { linkedin: /linkedin/i, instagram: /instagram/i, youtube: /youtube|google/i, outlook: /microsoft|outlook/i };
  return (aliases[platform] || new RegExp(platform, 'i')).test(String(text || ''));
}

export async function readOutlookVerificationCode({ context, platform, timeoutMs = 25000,
  now = Date.now, maxAgeMs = 15 * 60 * 1000, pollMs = 1500 } = {}) {
  if (!context || typeof context.newPage !== 'function') return { code: null, reason: 'context_unavailable' };
  let page = null;
  try {
    page = await context.newPage();
    await page.goto('https://outlook.live.com/mail/0/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      await page.waitForTimeout(pollMs).catch(() => {});
      const messages = await page.evaluate(() => [...document.querySelectorAll('[role="option"]')]
        .slice(0, 25).map(element => (element.innerText || '').replace(/\s+/g, ' ').trim())).catch(() => []);
      const match = messages.find(text => platformMatches(text, platform));
      if (!match) continue;
      // Open the newest matching message and read the reading pane.
      await page.evaluate(text => {
        const element = [...document.querySelectorAll('[role="option"]')]
          .find(item => (item.innerText || '').replace(/\s+/g, ' ').trim() === text);
        if (element) element.click();
      }, match).catch(() => {});
      await page.waitForTimeout(1200).catch(() => {});
      const body = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ')).catch(() => '');
      const code = extractVerificationCode(body, { platform });
      if (code) return { code, subject: match.slice(0, 120), readAt: new Date(now()).toISOString() };
    }
    return { code: null, reason: 'no_matching_code' };
  } catch (error) {
    return { code: null, reason: `mailbox_${String(error?.name || 'error').toLowerCase()}`.slice(0, 60) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
