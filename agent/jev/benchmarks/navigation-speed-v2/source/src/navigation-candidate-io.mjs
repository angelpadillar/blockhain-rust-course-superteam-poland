import { navigationActions, navigationSelector, navigationContract } from './navigation.mjs';

export class CandidateStaleError extends Error {
  constructor() {
    super('candidate_stale_snapshot');
    this.name = 'CandidateStaleError';
    this.code = 'candidate_stale_snapshot';
    this.retryable = true;
  }
}

// Self-contained browser callback. Its observation reader mirrors the unchanged
// readNavigationDom; fixture parity tests guard this duplication. Capturing the
// node array and observations in one JS turn binds indices to actual elements.
// No eval, attributes, persistent page globals, or synthetic input is used.
export function captureCandidateDom(body, { selector, selected = null }) {
  const nodes = [...body.querySelectorAll(selector)];
  const visible = e => {
    if (!e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return false;
    for (let p = e.parentElement; p && p !== body; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (/hidden|clip/.test(style.overflowY) && p.getBoundingClientRect().height < 1) return false;
    }
    return true;
  };
  const dialogs = [...body.querySelectorAll('[role="dialog"],dialog')].filter(visible);
  const dialog = dialogs.at(-1);
  const controls = nodes.flatMap((e, index) => {
    if (!visible(e) || e.disabled || e.getAttribute('aria-disabled') === 'true' || e.closest('footer')
      || (dialog && !dialog.contains(e))) return [];
    const tag = e.tagName.toLowerCase();
    return [{ index, tag, label: (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || '').trim().slice(0, 240),
      href: e.getAttribute('href') || '', type: e.type || '', value: e.value || '',
      purpose: (tag === 'h3' || (tag === 'p' && e.textContent.trim() === e.closest('[class*="ItemRow_itemRow"]')?.querySelector('img[alt]')?.getAttribute('alt')))
        && e.closest('[class*="ItemTile_itemTile"],[class*="ItemRow_itemRow"]') ? 'product'
        : tag === 'h3' && e.closest('[class*="StoreMenuItem_listItem"]') ? 'category' : '' }];
  });
  const observation = { controls, text: body.innerText,
    siteUnavailable: /Oh, no![\s\S]*It looks like there's a problem, but we're working on it\./i.test(body.innerText),
    closedStoreNotice: dialogs.some(d => /teraz nie pracuje\. Następne otwarcie:|Punkt .+ jest tymczasowo zamknięty/i.test(d.innerText)),
    ageConfirmationRequired: dialogs.some(d => /Potwierdź pełnoletniość|Confirm (?:your )?age|Age verification/i.test(d.innerText)),
    dialogTitles: dialogs.flatMap(d => [...d.querySelectorAll('h1,h2')].filter(visible).map(e => e.innerText.trim())),
    headings: [...body.querySelectorAll('h1,h2')].filter(visible).map(e => e.innerText.trim()).slice(0, 30),
    url: location.href };
  const roles = new Set(['link', 'button', 'searchbox', 'textbox', 'heading', 'menuitem', 'tab']);
  const contexts = Object.fromEntries(controls.map(control => {
    const node = nodes[control.index], role = node.getAttribute('role');
    return [control.index, {
      role: roles.has(role) ? role : control.tag === 'a' ? 'link' : control.tag === 'button' ? 'button'
        : control.tag === 'input' ? (control.type === 'search' ? 'searchbox' : 'textbox')
        : control.tag === 'h3' ? 'heading' : 'text',
      where: [node.closest('main,[role="main"]') && 'main', node.closest('nav,[role="navigation"]') && 'nav',
        (node.closest('[role="search"]') || control.type === 'search') && 'search',
        control.purpose === 'product' && 'product', control.purpose === 'category' && 'category'].filter(Boolean),
    }];
  }));
  return { observation, nodes, contexts,
    selectedIndex: selected?.isConnected && selected.ownerDocument === body.ownerDocument ? nodes.indexOf(selected) : -1 };
}

const signature = action => JSON.stringify([action?.kind, action?.value, action?.control]);
const disposeHandle = async handle => { if (handle) await handle.dispose().catch(() => {}); };

export function createCandidateIO(page, task) {
  navigationContract(task);
  let generation = 0, current = null, disposed = false;
  function snapshot(observation) {
    if (disposed || !current || current.observation !== observation || current.consumed) throw new CandidateStaleError();
    return current;
  }
  async function invalidate() {
    const previous = current;
    current = null;
    await disposeHandle(previous?.handle);
  }
  function offered(snap, action) {
    const valid = navigationActions(snap.baseline, task).find(candidate => signature(candidate) === signature(action));
    if (!valid || (action.ref !== undefined && action.ref !== `s${snap.generation}:e${valid.control.index}`)) throw new CandidateStaleError();
    return valid;
  }
  return {
    async observe() {
      if (disposed) throw new CandidateStaleError();
      await invalidate();
      const handle = await page.locator('body').evaluateHandle(captureCandidateDom, { selector: navigationSelector });
      try {
        const data = await handle.evaluate(value => ({ observation: value.observation, contexts: value.contexts }));
        const observation = data.observation;
        current = { handle, observation, baseline: structuredClone(observation), contexts: data.contexts,
          generation: ++generation, consumed: false };
        return observation;
      } catch (error) { await disposeHandle(handle); throw error; }
    },
    bind(observation, actions = navigationActions(observation, task)) {
      const snap = snapshot(observation), all = navigationActions(snap.baseline, task);
      return actions.map(action => {
        const valid = offered(snap, action), context = snap.contexts[valid.control.index];
        return { ...structuredClone(action), ref: `s${snap.generation}:e${valid.control.index}`,
          what: valid.description, where: [...context.where], role: context.role,
          supports: [...new Set(all.filter(candidate => candidate.control.index === valid.control.index).map(candidate => candidate.kind))] };
      });
    },
    async execute(observation, action) {
      const snap = snapshot(observation), valid = offered(snap, action);
      if (page.url() !== snap.baseline.url) throw new CandidateStaleError();
      let selected, fresh, dispatchStarted = false;
      try {
        selected = (await snap.handle.evaluateHandle((value, index) => value.nodes[index], valid.control.index)).asElement();
        if (!selected) throw new CandidateStaleError();
        fresh = await page.locator('body').evaluateHandle(captureCandidateDom, { selector: navigationSelector, selected });
        const data = await fresh.evaluate(value => ({ observation: value.observation, selectedIndex: value.selectedIndex }));
        if (snapshot(observation) !== snap || data.observation.url !== snap.baseline.url || data.selectedIndex < 0) throw new CandidateStaleError();
        const freshValid = navigationActions(data.observation, task).find(candidate => candidate.control.index === data.selectedIndex
          && candidate.kind === valid.kind && candidate.value === valid.value
          && JSON.stringify({ ...candidate.control, index: valid.control.index }) === JSON.stringify(valid.control));
        if (!freshValid) throw new CandidateStaleError();
        // From here on dispatch may have happened. Never translate a timeout,
        // detach or navigation error into the retryable pre-action stale type.
        dispatchStarted = true;
        snap.consumed = true;
        if (valid.kind === 'fill') await selected.fill(valid.value, { timeout: 5000 });
        else if (valid.kind === 'press') await selected.press('Enter', { timeout: 5000 });
        else await selected.click({ timeout: 5000 });
      } finally {
        await disposeHandle(fresh);
        await disposeHandle(selected);
        if (dispatchStarted && current === snap) await invalidate();
      }
    },
    async dispose() { disposed = true; await invalidate(); },
  };
}
