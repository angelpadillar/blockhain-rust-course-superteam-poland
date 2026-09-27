#!/usr/bin/env node
/**
 * Append one decision record from stdin.
 *
 *   node cli/record.mjs --dir .browser-decisions <<'JSON'
 *   { "job_id": "...", "profile_id": "...", ... }
 *   JSON
 *
 * `--strict` fails closed on secret material; default redacts and records the
 * redaction path (safe for read-only context).
 */
import { readFileSync } from 'node:fs';
import { createDecisionLogger } from '../lib/logger.mjs';

const arg = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const dir = arg('--dir', process.env.BROWSER_DECISION_LOG_DIR ?? '.browser-decisions');
const strict = process.argv.includes('--strict');
const input = readFileSync(0, 'utf8').trim();
if (!input) {
  console.error('no JSON on stdin');
  process.exit(2);
}
let parsed;
try {
  parsed = JSON.parse(input);
} catch (error) {
  console.error(`invalid JSON: ${error.message}`);
  process.exit(2);
}
const logger = createDecisionLogger({ dir, redact: !strict, onRedaction: (redactions) => console.error(JSON.stringify({ redactions })) });
const result = logger.append(parsed);
console.log(JSON.stringify(result));
