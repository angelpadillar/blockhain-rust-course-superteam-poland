const methods = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE']);
const actionTypes = new Set(['click', 'fill', 'press', 'authorized_site_confirmation']);
const endpointSegments = new Set(['v1', 'v2', 'v3', 'v4', 'v5', 'stores', 'addresses', 'address', 'products', 'product',
  'details', 'view', 'catalog', 'catalogue', 'search', 'availability', 'collections', 'menus', 'cart', 'carts', 'basket', 'baskets',
  'orders', 'order', 'payments', 'payment', 'transactions', 'transaction']);

export function navigationEndpointTemplate(url) {
  return '/' + new URL(url).pathname.split('/').filter(Boolean).slice(0, 24)
    .map(segment => endpointSegments.has(segment.toLowerCase()) ? segment.toLowerCase() : ':segment').join('/');
}

// Keep this classification aligned with the existing mutation guard. It does not
// decide what to block. The path template contains fixed literals only; every
// unknown segment is replaced and host, query and fragment are never retained.
export function blockedMutationDiagnostic(method, url, action = null) {
  const endpoint = new URL(url).pathname.match(/\/(carts?|baskets?|orders?|payments?|transactions?|address(?:es)?)(?:\/|$)/i)?.[1].toLowerCase();
  const endpointClass = endpoint?.startsWith('address') ? 'address' : endpoint?.replace(/s$/, '');
  if (!endpointClass) throw new Error('unclassified_navigation_mutation');
  const normalizedMethod = String(method).toUpperCase();
  return { type: 'navigation_mutation_blocked', method: methods.has(normalizedMethod) ? normalizedMethod : 'OTHER', endpointClass,
    endpointTemplate: navigationEndpointTemplate(url),
    ...(Number.isSafeInteger(action?.sequence) && action.sequence > 0 ? { actionSequence: action.sequence } : {}),
    ...(actionTypes.has(action?.type) ? { actionType: action.type } : {}) };
}

export function navigationActionContext(current, event) {
  if (event.type === 'step_completed' || event.type === 'run_stopped' || event.type === 'completion_verified') return null;
  if (!['action_planned', 'action_executed'].includes(event.type)) return current;
  const sameAction = current != null && current.sequence === event.step;
  const type = actionTypes.has(event.kind) ? event.kind
    : event.action === 'repeat_scoped_age_confirmation' ? 'authorized_site_confirmation'
    : sameAction ? current.type : undefined;
  return { ...(Number.isSafeInteger(event.step) && event.step > 0 ? { sequence: event.step } : {}),
    ...(type ? { type } : {}) };
}

// Dependencies are injected: this module performs no filesystem or browser I/O.
// A shared queue prevents concurrent route callbacks from overwriting newer
// journal snapshots. A failed write latches cancellation before routes resume.
export function createNavigationDiagnostics({ journal, abort }) {
  let action = null, pending = Promise.resolve(), failure = null;
  function fail() {
    if (!failure) {
      failure = Object.assign(new Error('navigation_journal_failed'), { code: 'navigation_journal_failed' });
      abort(failure);
    }
    return failure;
  }
  function enqueue(write, terminal = false) {
    const operation = pending.then(() => {
      if (failure && !terminal) throw failure;
      return write();
    }).catch(() => { throw fail(); });
    // Keep the queue usable for a final failure report without leaving an
    // unhandled rejection when a route callback is being closed by the browser.
    pending = operation.catch(() => {});
    return operation;
  }
  return {
    async onEvent(event) {
      const next = navigationActionContext(action, event);
      await enqueue(() => journal.record(event));
      action = next;
    },
    async blockMutation(method, url, abortRequest) {
      try {
        const event = blockedMutationDiagnostic(method, url, action);
        await enqueue(() => journal.record(event));
      } catch {
        fail();
      } finally {
        // Journal failure must never leave a blocked request paused forever.
        // Closing a cancelled context may already have disposed of the route.
        try { await abortRequest(); } catch { /* The request/context may already be closed. */ }
      }
    },
    async flush() {
      let tail;
      do { tail = pending; await tail; } while (tail !== pending);
      if (failure) throw failure;
    },
    finish(result) {
      // Even after an earlier failure, attempt to durably record the terminal
      // incomplete result. This never clears the latched cancellation.
      return enqueue(() => journal.finish(result), true);
    },
  };
}
