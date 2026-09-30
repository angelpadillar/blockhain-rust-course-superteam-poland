// src/generated must be what scripts/codegen.mjs renders from the committed
// IDL. Regenerate with `npm run codegen`.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { render } from '../scripts/codegen.mjs';

function files(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();
}

test('generated client is current', async () => {
  const committed = fileURLToPath(new URL('../src/generated', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'will-escrow-codegen-'));
  try {
    await render(scratch);
    const fresh = join(scratch, 'src/generated');
    assert.deepEqual(files(committed), files(fresh), 'stale client: run npm run codegen');
    for (const file of files(fresh)) {
      assert.equal(
        readFileSync(join(committed, file), 'utf8'),
        readFileSync(join(fresh, file), 'utf8'),
        `stale ${file}: run npm run codegen`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
