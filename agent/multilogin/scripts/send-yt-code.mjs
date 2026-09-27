import { readFile } from 'node:fs/promises';
import { totp } from '../src/core.mjs';
import { notifyHuman } from '../src/human-notify.mjs';

// Generate the current (and next) TOTP code for an owned account and send it to
// the operator's Discord with a short validity note. Use whenever a platform
// asks for a 6-digit code during a parked flow.
//
// Usage:
//   node scripts/send-yt-code.mjs --ref yt-live-04 [--accounts-file /data/accounts.json] [--chat] [--label "K04/YT"]

export function parseArguments(argv) {
  const options = { positional: [] };
  const valueFlags = ['--ref', '--accounts-file', '--label'];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--chat') options.chat = true;
    else if (valueFlags.includes(token)) {
      const value = argv[index + 1];
      options[token.slice(2)] = value;
      index++;
    } else if (token.startsWith('--')) throw new Error(`unknown argument ${token}`);
    else options.positional.push(token);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const ref = options.ref;
  if (!ref) {
    // List available refs without printing secrets.
    const accounts = JSON.parse(await readFile(options['accounts-file'] || '/data/accounts.json', 'utf8'));
    console.log(JSON.stringify({ refs: accounts.map((account) => ({ ref: account.ref, platform: account.platform, account: account.username })) }, null, 2));
    return 0;
  }
  const accounts = JSON.parse(await readFile(options['accounts-file'] || '/data/accounts.json', 'utf8'));
  const account = accounts.find((entry) => entry.ref === ref || entry.username === ref);
  if (!account?.totp) {
    console.log(JSON.stringify({ ok: false, reason: 'no_totp_for_ref', ref }, null, 2));
    return 2;
  }
  const now = totp(account.totp);
  const next = totp(account.totp, Date.now() + 30000);
  const label = options.label || ref;
  const result = await notifyHuman({
    label,
    state: 'CODE_REQUESTED',
    reason: `totp_code (valid ~${Math.floor(now.validForMs / 1000)}s)`,
    visibleText: `code now: ${now.code} | next: ${next.code}`,
  });
  const output = { ok: true, ref, label, code: now.code, nextCode: next.code, validForMs: now.validForMs, discord: result };
  console.log(JSON.stringify(output, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(JSON.stringify({ status: 'error', error: String(error?.message ?? error).slice(0, 200) }));
    process.exit(2);
  });
}
