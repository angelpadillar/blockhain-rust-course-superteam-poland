import test from 'node:test';
import assert from 'node:assert/strict';
import { installDialogGuard, isStaleDialogError, assertSingleBrowserOwner,
  maxBrowserOwners } from '../src/dialog-containment.mjs';

// Ported from the VPS canary (2026-09-25): the stale-dialog race must never kill
// the job process, and the single-owner invariant must stay enforceable.
function pageDouble() {
  const listeners = new Map();
  return {
    listeners,
    on: (event, handler) => listeners.set(event, handler),
    off: event => listeners.delete(event),
    emit: async (event, payload) => listeners.get(event)?.(payload),
  };
}

test('a stale Page.handleJavaScriptDialog race is contained as a diagnostic', async () => {
  const page = pageDouble();
  const diagnostics = [];
  const guard = installDialogGuard(page, { onDiagnostic: async detail => diagnostics.push(detail) });
  await page.emit('dialog', { dismiss: async () => {
    throw new Error('ProtocolError (Page.handleJavaScriptDialog): No dialog is showing');
  } });
  assert.equal(guard.state.seen, 1);
  assert.equal(guard.state.contained, 1);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].reason, 'stale_dialog_race');
  assert.equal(isStaleDialogError({ message: 'No dialog is showing' }), true);
  guard.dispose();
  assert.equal(page.listeners.has('dialog'), false, 'the guard can be removed');
});

test('an unexpected dialog error is not swallowed', async () => {
  const page = pageDouble();
  installDialogGuard(page, {});
  await assert.rejects(page.emit('dialog', { dismiss: async () => { throw new Error('unexpected failure'); } }),
    /unexpected failure/);
});

test('the default action dismisses; acceptance is explicit and never implicit', async () => {
  const dismissed = [];
  const accepted = [];
  const page = pageDouble();
  const guard = installDialogGuard(page, {});
  await page.emit('dialog', { dismiss: async () => dismissed.push('dismiss'), accept: async () => accepted.push('accept') });
  assert.deepEqual(dismissed, ['dismiss']);
  assert.deepEqual(accepted, []);
  guard.dispose();
  const acceptPage = pageDouble();
  const acceptGuard = installDialogGuard(acceptPage, { action: 'accept' });
  await acceptPage.emit('dialog', { dismiss: async () => dismissed.push('second-dismiss'),
    accept: async () => accepted.push('accept') });
  assert.deepEqual(accepted, ['accept']);
  acceptGuard.dispose();
});

test('only one browser/CDP owner is allowed', () => {
  assert.equal(maxBrowserOwners, 1);
  assert.deepEqual(assertSingleBrowserOwner({ owners: ['session'] }), { owners: 1, ok: true });
  assert.throws(() => assertSingleBrowserOwner({ owners: ['a', 'b'] }), /multiple_browser_owners:2/);
});
