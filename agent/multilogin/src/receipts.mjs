import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireThat } from './core.mjs';
import { receiptStates } from './contract.mjs';

// Durable receipts. Every state change is appended before the next step, so a
// crash leaves the last known state on disk. The journal is private (mode 600)
// and append-only, and a new process re-reads it after a restart.
export const receiptJournalName = 'receipts.ndjson';
// A receipt in one of these states may still have an external effect in flight.
export const inFlightStates = ['created', 'dispatched', 'uncertain'];
export const isInFlight = receipt => inFlightStates.includes(receipt?.state);
export const unresolvedStates = ['dispatched', 'uncertain'];

export function createReceiptStore({ directory, file = receiptJournalName, fsync = true } = {}) {
  requireThat(typeof directory === 'string' && directory.length > 0, 'receipt_directory_required');
  const path = resolve(directory, file);
  const ready = mkdir(dirname(path), { recursive: true, mode: 0o700 });

  const entries = async () => {
    await ready;
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const parsed = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // A torn final line is a crash artefact: it is skipped rather than
      // allowed to hide the states that were written durably before it.
      try { parsed.push(JSON.parse(line)); } catch { continue; }
    }
    return parsed;
  };

  const latest = async () => {
    const byId = new Map();
    for (const entry of await entries()) byId.set(entry.id, entry);
    return byId;
  };

  return {
    path,
    // Appended before dispatch and after every state change.
    async write(receipt) {
      requireThat(receipt?.id && receiptStates.includes(receipt.state), 'invalid_receipt');
      await ready;
      const handle = await open(path, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(receipt)}\n`);
        if (fsync) await handle.sync();
      } finally { await handle.close(); }
      return receipt;
    },
    entries,
    latest,
    async find({ id = null, idempotencyKey = null } = {}) {
      const byId = await latest();
      for (const receipt of byId.values()) {
        if (id && receipt.id === id) return receipt;
        if (idempotencyKey && receipt.idempotencyKey === idempotencyKey) return receipt;
      }
      return null;
    },
    // Receipts a restart must reconcile: the latest state of anything that may
    // still have an effect in flight.
    async inFlight({ states = inFlightStates } = {}) {
      return [...(await latest()).values()].filter(receipt => states.includes(receipt.state));
    },
    async privateFile() {
      try { const info = await stat(path); return (info.mode & 0o077) === 0; }
      catch { return false; }
    },
  };
}
