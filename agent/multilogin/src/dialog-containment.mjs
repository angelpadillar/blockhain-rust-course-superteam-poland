// Stale-dialog containment, ported from the VPS canary checkpoint work
// (2026-09-25). It exists because Playwright auto-dismisses dialogs: when a
// dialog closes between the event and the dismissal, that internal dismissal
// throws `ProtocolError (Page.handleJavaScriptDialog): No dialog is showing` and
// the rejection can kill the whole job process.
//
// Our handler replaces the auto-dismissal with a guarded dismissal: the known
// stale races become a diagnostic, everything else keeps its normal behaviour.
export const staleDialogPatterns = [
  /no dialog is showing/i,
  /target closed/i,
  /page closed/i,
  /browser has been closed/i,
  /execution context was destroyed/i,
];

export function isStaleDialogError(error) {
  const text = `${error?.message || ''} ${error?.method || ''}`;
  if (/handleJavaScriptDialog/i.test(text)) return true;
  return staleDialogPatterns.some(pattern => pattern.test(text));
}

// Returns counters and a disposer. `onDiagnostic` is injected so the caller can
// journal the containment; dismissal is bounded and never accepts by default.
export function installDialogGuard(page, { onDiagnostic = async () => {}, action = 'dismiss' } = {}) {
  const state = { seen: 0, contained: 0, lastError: null };
  const handler = async dialog => {
    state.seen++;
    try {
      if (action === 'accept') await dialog.accept();
      else await dialog.dismiss();
    } catch (error) {
      if (!isStaleDialogError(error)) throw error;
      state.contained++;
      state.lastError = error?.message?.slice(0, 120) || 'stale_dialog';
      await Promise.resolve(onDiagnostic({ reason: 'stale_dialog_race', detail: state.lastError })).catch(() => {});
    }
  };
  page.on('dialog', handler);
  return { state, dispose: () => page.off?.('dialog', handler) };
}

// The invariant the live path depends on: exactly one browser/CDP owner.
export const maxBrowserOwners = 1;

export function assertSingleBrowserOwner({ owners } = {}) {
  const count = Array.isArray(owners) ? owners.length : Number(owners) || 0;
  if (count > maxBrowserOwners) {
    const error = new Error(`multiple_browser_owners:${count}`);
    error.code = 'multiple_browser_owners';
    throw error;
  }
  return { owners: count, ok: true };
}
