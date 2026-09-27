// Atomic in-page observation. One evaluateHandle call captures every visible
// actionable control with its real node reference, its enclosing semantic
// component (the disambiguation layer: a card/row/dialog label that tells
// sixteen identical buttons apart), page headings and visible text for local
// done-when checks, and a goal-directed readiness wait driven by a
// MutationObserver — never fixed page-quiet sleeps.
//
// The page runs read-only JavaScript. Labels and page text are untrusted
// evidence; they describe candidates, never carry instructions.

export function inspectPage(body, options) {
  // Declared inside the function: page functions are serialized into the
  // browser and cannot see module scope.
  const CONTROL_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'summary',
    '[role="button"]', '[role="link"]', '[role="tab"]', '[role="option"]',
    '[role="checkbox"]', '[role="radio"]', '[role="switch"]', '[role="menuitem"]',
    '[role="combobox"]', '[role="listbox"]', '[role="searchbox"]', '[role="textbox"]',
    '[role="spinbutton"]', '[contenteditable="true"]',
  ].join(',');
  const COMPONENT_SELECTOR = [
    'article', '[role="article"]', '[role="listitem"]', '[role="row"]', 'li', 'tr',
    '[role="group"]', '[role="region"]', 'section', 'form', 'dialog', '[role="dialog"]',
    '[itemscope]', '[data-testid]', '[data-test-id]',
  ].join(',') + (options.componentSelector ? `,${options.componentSelector}` : '');

  const norm = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const denyTerms = (options.deny || []).map(term => String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const denyRe = denyTerms.length ? new RegExp(`\\b(?:${denyTerms.join('|')})\\b`, 'i') : null;
  const denied = value => Boolean(denyRe && denyRe.test(value));
  const denyPathRe = options.denyPath ? new RegExp(`\\/(?:${options.denyPath})(?:\\/|$)`, 'i') : null;
  const denyPath = value => Boolean(denyPathRe && denyPathRe.test(value));
  const safe = value => {
    try {
      const u = new URL(value, location.href);
      return ['http:', 'https:'].includes(u.protocol) && u.origin === options.origin && !u.username && !u.password
        && !denyPath(u.pathname);
    } catch { return false; }
  };
  const parentOf = node => node.parentElement || node.getRootNode()?.host || null;
  function queryDeep(root, selector) {
    const out=[];
    for(const node of root.querySelectorAll('*')) {
      if(node.matches(selector))out.push(node);
      if(node.shadowRoot)out.push(...queryDeep(node.shadowRoot,selector));
    }
    return out;
  }
  function closestDeep(node, selector) {
    for(let current=node;current;current=parentOf(current))if(current.matches(selector))return current;
    return null;
  }
  function shadowPath(node) {
    const path=[];
    for(let root=node.getRootNode();root?.host;root=root.host.getRootNode())path.unshift(root.host.tagName.toLowerCase()+':'+(root.host.getAttribute('aria-label')||''));
    return path;
  }
  const visible = element => {
    if (!element.isConnected || !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden'
      || !element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
    for (let parent = element; parent && parent !== body; parent = parentOf(parent)) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || parent.getAttribute('aria-hidden') === 'true'
        || (/hidden|clip/.test(style.overflowY) && parent.getBoundingClientRect().height < 1)) return false;
    }
    return true;
  };
  const inViewport = element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  };
  const labelOf = element => (element.getAttribute('aria-label')
    || (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => element.getRootNode().getElementById?.(id)?.textContent || '').join(' ').trim()
    || [...(element.labels || [])].map(label => label.textContent).join(' ')
    || element.getAttribute('placeholder')
    || (element.innerText || '')
    || element.getAttribute('title')
    || element.getAttribute('alt')
    || element.getAttribute('value')
    // Unlabeled form controls fall back to their field identity — file inputs
    // and legacy forms frequently have no accessible name but a useful name/id.
    || (element.matches('input,select,textarea') ? element.getAttribute('name') || element.getAttribute('id') : '')
    || '').trim().slice(0, 120);
  // The component layer: the nearest ancestor carrying its own identity label
  // (heading, aria-label, itemprop name, image alt, test id). This is what
  // distinguishes "Add" inside ProductCard[KALLAX white 2x2] from the same
  // "Add" inside ProductCard[KALLAX black-brown 2x2].
  function componentOf(element) {
    for (let parent = parentOf(element), depth = 0; parent && parent !== body && depth < 8; parent = parentOf(parent), depth++) {
      if (!parent.matches(COMPONENT_SELECTOR)) continue;
      const own = (parent.getAttribute('aria-label')
        || parent.querySelector('h1,h2,h3,h4,header,legend,figcaption,[itemprop="name"],strong,b')?.innerText
        || parent.querySelector('img[alt]')?.getAttribute('alt')
        || parent.getAttribute('title')
        || parent.getAttribute('data-testid')
        || parent.getAttribute('data-test-id')
        || '').trim().slice(0, 120);
      if (!own) continue;
      const tag = parent.tagName.toLowerCase();
      const role = parent.getAttribute('role') || '';
      const kind = role === 'dialog' || tag === 'dialog' ? 'dialog'
        : tag === 'form' ? 'form'
        : tag === 'section' || role === 'region' ? 'region'
        : tag === 'article' || role === 'article' ? 'card'
        : role === 'listitem' || tag === 'li' ? 'listitem'
        : role === 'row' || tag === 'tr' ? 'row'
        : role === 'group' ? 'group' : 'container';
      // A short excerpt of the component's own text (price, variant, stock)
      // rides along for small containers — that is where the facts a choice
      // between identical-looking controls actually lives.
      const text = ['card', 'listitem', 'row'].includes(kind)
        ? (parent.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      return { kind, label: own, text };
    }
    return null;
  }
  function supportsOf(node, tag, type, role) {
    if (tag === 'select') return ['select'];
    if (tag === 'textarea' || node.isContentEditable) return ['fill'];
    if (tag === 'input') {
      if (['checkbox', 'radio'].includes(type) || ['button', 'submit', 'reset', 'image'].includes(type)) return ['click'];
      if (type === 'file') return ['upload'];
      if (['hidden', 'password', 'range', 'color'].includes(type)) return [];
      return ['fill', 'press'];
    }
    if (role === 'combobox' || role === 'searchbox' || role === 'textbox' || role === 'spinbutton') return ['fill', 'press', 'click'];
    if (role === 'checkbox' || role === 'radio' || role === 'switch') return ['click'];
    if (tag === 'a' || tag === 'button' || tag === 'summary'
      || ['button', 'link', 'tab', 'option', 'menuitem'].includes(role)) return ['click'];
    return [];
  }
  const kindOf = (node, tag, type, role, editable) => {
    if (tag === 'select' || role === 'listbox') return 'select';
    if (editable && (type === 'search' || role === 'searchbox' || /\b(?:search|find|lookup|szukaj|wyszukaj)\b/i.test(labelOf(node)))) return 'search';
    if (editable) return 'field';
    if (tag === 'input' && type === 'file') return 'file';
    if (tag === 'a') return 'link';
    if (['checkbox', 'radio', 'switch'].includes(role) || ['checkbox', 'radio'].includes(type)) return 'toggle';
    if (['option', 'tab', 'menuitem'].includes(role)) return 'choice';
    return 'button';
  };
  let wakeups = 0, scans = 0;
  const activeDialog = () => queryDeep(body,'[role="dialog"],dialog').filter(visible).at(-1) || null;
  function scan() {
    scans++;
    const dialog = activeDialog();
    const scope = dialog || body;
    const nodes = queryDeep(scope,CONTROL_SELECTOR + (options.extraSelector ? `,${options.extraSelector}` : ''));
    const baseline = options.baseline;
    const controls = [];
    let eligible = 0;
    for (const [index, node] of nodes.entries()) {
      if (!visible(node) || node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
      const tag = node.tagName.toLowerCase(), type = (node.type || '').toLowerCase(), role = node.getAttribute('role') || '';
      if (tag === 'input' && type === 'hidden') continue;
      const what = labelOf(node);
      if (!what && tag !== 'select') continue;
      if (denied(what)) continue;
      if (tag === 'a' && (!safe(node.href) || node.hasAttribute('download'))) continue;
      const editable = node.matches('input,textarea,[contenteditable="true"]') && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'hidden', 'file', 'password', 'range', 'color'].includes(type);
      let supports = supportsOf(node, tag, type, role);
      // Site adapters may declare extra clickable pseudo-controls (Glovo
      // product titles render as h3/p inside clickable tiles).
      if (!supports.length && options.extraSelector && node.matches(options.extraSelector)) supports = ['click'];
      if (!supports.length) continue;
      const region = closestDeep(node,'section[aria-label],[role="region"][aria-label],form[aria-label],nav[aria-label]');
      const where = [closestDeep(node,'main,[role="main"]') && 'main', closestDeep(node,'nav,[role="navigation"]') && 'navigation',
        closestDeep(node,'[role="search"]') && 'search', closestDeep(node,'header') && 'header', closestDeep(node,'footer') && 'footer',
        region?.getAttribute('aria-label')?.slice(0, 100)].filter(Boolean);
      const component = componentOf(node);
      const oldIndex = baseline?.nodes.indexOf(node) ?? -1;
      const old = oldIndex >= 0 ? baseline?.data.controls.find(control => control.nodeIndex === oldIndex) : null;
      const fresh = options.freshDocument || !old || old.what !== what || old.href !== (node.href || '') || old.value !== (node.value ?? '');
      const control = { nodeIndex: index, kind: kindOf(node, tag, type, role, editable), what, role: role || tag,
        where, component, supports, tag, type, name: node.getAttribute('name') || '',
        // A required marker tells the decider the field blocks submission —
        // without it a model may skip fields it can't match a value to. The
        // trailing-asterisk convention covers JS-only validation (RHF et al.)
        // that never sets the attribute.
        required: Boolean(node.required || node.getAttribute('aria-required') === 'true' || /\*\s*$/.test(what)
          || [...(node.labels || [])].some(l => /required/i.test(l.className || ''))),
        value: editable ? (node.value ?? '') : '', inViewport: inViewport(node), fresh: Boolean(fresh), shadowPath: shadowPath(node) };
      // Adapter-declared purpose (e.g. Glovo product tile vs category row):
      // first matching selector wins — checked against ancestors AND the
      // element's own class list (search-result rows carry the marker class
      // on the title node itself, not a wrapper).
      if (options.purposeMap) {
        const ownClass = typeof node.className === 'string' ? node.className : '';
        const found = options.purposeMap.find(entry => {
          try {
            if (closestDeep(node, entry.selector)) return true;
            // [class*="X"] fragments also match the element's own classes.
            return [...entry.selector.matchAll(/\[class\*="([^"]+)"\]/g)].some(m => ownClass.includes(m[1]));
          } catch { return false; }
        });
        if (found) control.purpose = found.purpose;
      }
      if (tag === 'a') control.href = node.href;
      // Toggle state must be observable: a click on a checkbox is a blind
      // toggle, so a control that hides its checked state invites re-clicks.
      if (['checkbox', 'radio'].includes(type) || ['checkbox', 'radio', 'switch'].includes(role)) {
        control.checked = Boolean(node.checked || node.getAttribute('aria-checked') === 'true' || node.getAttribute('aria-selected') === 'true');
      }
      // A radio group's title is usually a sibling label/legend of the
      // members' shared container ("Contact Preference"), not an ancestor —
      // componentOf cannot reach it, so find it over the named group.
      if (type === 'radio' && control.name) {
        const scope = node.form || closestDeep(node, 'form') || body;
        let members = [];
        try { members = [...scope.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`)]; } catch {}
        if (members.length) {
          let anc = members[0];
          while (anc && anc !== body && !members.every(m => anc.contains(m))) anc = parentOf(anc);
          const own = new Set(members.flatMap(m => [...(m.labels || [])].map(l => (l.textContent || '').trim())));
          const title = anc && (anc.querySelector('legend')
            || [...anc.querySelectorAll('label')].find(l => !own.has((l.textContent || '').trim()))
            || anc.querySelector('strong,b'));
          const label = (title?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
          if (label) {
            control.groupLabel = label;
            // CSS-only required marks (class="label-required", ::after
            // asterisks) carry no attribute — read the title's own markers.
            if (/\*\s*$/.test(label) || /required/i.test(title.className || '') || title.getAttribute('aria-required') === 'true') {
              control.groupRequired = true;
            }
          }
        }
      }
      if (type === 'file') { control.accept = node.getAttribute('accept') || ''; control.required = node.required; }
      if (tag === 'select') control.options = [...node.options].slice(0, 24)
        .map((option, i) => ({ index: i, label: option.label.trim().slice(0, 80), selected: option.selected }));
      if (type === 'search' || role === 'searchbox' || control.kind === 'search') {
        const form = node.form || closestDeep(node, 'form');
        control.submit = Boolean(form && (form.getAttribute('method') || 'get').toLowerCase() === 'get' && safe(form.action || location.href));
        control.live = role === 'searchbox' || ['list', 'both'].includes(node.getAttribute('aria-autocomplete')) || Boolean(node.getAttribute('aria-controls'));
      }
      eligible++;
      if (controls.length < options.cap) controls.push(control);
    }
    const headings = queryDeep(scope,'h1,h2,h3,[role="heading"]').filter(visible).map(node => node.innerText.trim().slice(0, 200));
    const text = scope.innerText.slice(0, options.textCap);
    const emptyResults = queryDeep(scope,'[role="status"],[role="alert"]').filter(visible)
      .some(node => /\b(?:no (?:matching )?(?:results|items|matches)|nothing found|0 results)\b/i.test(node.innerText));
    // Visible validation feedback. Client-side rejection renders messages
    // without touching any control, so a submit that fails validation looks
    // identical to a dead click unless the digest is part of the page state.
    const FEEDBACK_SELECTOR = '[role="alert"],[role="status"],[aria-live],[class*="error" i],[id*="error" i],[class*="invalid" i],[class*="warning" i]';
    const hits = queryDeep(scope, FEEDBACK_SELECTOR).filter(visible);
    const feedback = [...new Set(hits.filter(node => !hits.some(other => other !== node && node.contains(other)))
      .map(node => (node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160)).filter(Boolean))].slice(0, 8);
    const ready = readyCheck({ controls, nodes, baseline, emptyResults, feedback });
    const data = { url: location.href, title: document.title.slice(0, 200), controls, headings, text, feedback,
      targetHeading: options.targetText ? headings.some(h => norm(h) === norm(options.targetText)) : false,
      emptyResults, truncated: eligible > controls.length, eligible,
      dialogOpen: Boolean(dialog), ready, observerWakeups: wakeups, browserScans: scans,
      canScrollDown: Math.ceil(scrollY + innerHeight) < document.documentElement.scrollHeight - 40,
      canScrollUp: scrollY > 40, historyLength: history.length,
      scrollY: Math.round(scrollY), selectedIndex: options.selected?.isConnected ? nodes.indexOf(options.selected) : -1 };
    return options.serializable ? { data } : { nodes, data };
  }
  // Goal-directed readiness. Evaluated inside the page on every mutation
  // wakeup; a null goal resolves immediately.
  function readyCheck({ controls, nodes, baseline, emptyResults, feedback }) {
    const goal = options.goal;
    if (!goal || !goal.type) return true;
    const oldKeys = baseline ? baseline.data.controls.map(c => `${c.kind}:${c.what}:${c.href || ''}`) : null;
    const newKeys = controls.map(c => `${c.kind}:${c.what}:${c.href || ''}`);
    const controlsChanged = !oldKeys || oldKeys.length !== newKeys.length || newKeys.some((key, i) => key !== oldKeys[i]);
    const feedbackChanged = baseline && JSON.stringify(feedback || []) !== JSON.stringify(baseline.data.feedback || []);
    switch (goal.type) {
      case 'change': return options.freshDocument || location.href !== goal.beforeUrl || document.title !== goal.beforeTitle || controlsChanged || feedbackChanged;
      case 'opened': return options.freshDocument || location.href !== goal.beforeUrl
        || (goal.heading ? queryDeep(body,'h1,h2,h3,[role="heading"]').filter(visible).some(h => norm(h.innerText).includes(norm(goal.heading))) : false);
      case 'results': return emptyResults || (controlsChanged && controls.some(c => c.fresh))
        || options.freshDocument || location.href !== goal.beforeUrl;
      // A named thing should now be OPEN — a dialog carrying its name (Glovo
      // product modal) or a navigated page showing it as a heading. URL params
      // update before content renders, so neither signal alone suffices.
      case 'product_opened': {
        const d = activeDialog();
        if (d && norm(d.innerText || '').includes(norm(goal.text))) return true;
        return options.freshDocument || (location.href !== goal.beforeUrl
          && queryDeep(body,'h1,h2,h3,[role="heading"]').filter(visible).some(h => norm(h.innerText).includes(norm(goal.text))));
      }
      case 'value': {
        const node = options.selected?.isConnected ? options.selected : nodes[goal.nodeIndex];
        if (!node) return false;
        return String(node.value ?? node.textContent ?? '').includes(goal.value || '');
      }
      case 'file': {
        const node = options.selected?.isConnected ? options.selected : nodes[goal.nodeIndex];
        return Boolean(node?.files?.length);
      }
      case 'selected': {
        const node = options.selected?.isConnected ? options.selected : nodes[goal.nodeIndex];
        if (!node) return false;
        if (typeof node.selectedIndex === 'number' && node.selectedIndex >= 0) return node.selectedIndex === goal.index;
        const option = node.options?.[goal.index];
        return Boolean(option?.selected || option?.getAttribute?.('aria-selected') === 'true');
      }
      case 'checked': {
        const node = options.selected?.isConnected ? options.selected : nodes[goal.nodeIndex];
        if (!node) return false;
        return Boolean(node.checked || node.getAttribute?.('aria-checked') === 'true' || node.getAttribute?.('aria-selected') === 'true');
      }
      case 'scroll': return Math.round(scrollY) !== goal.beforeScrollY;
      default: return true;
    }
  }
  const initial = scan();
  if (!options.waitMs || initial.data.ready) return initial;
  return new Promise(resolve => {
    const finish = value => { observer.disconnect(); clearTimeout(timer); resolve(value); };
    const observed = new Set();
    const attach = () => {
      for (const root of [body, ...queryDeep(body,'*').filter(node=>node.shadowRoot).map(node=>node.shadowRoot)]) {
        if (observed.has(root)) continue;
        observed.add(root);
        observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
      }
    };
    const observer = new MutationObserver(() => { wakeups++; attach(); const value = scan(); if (value.data.ready) finish(value); });
    attach();
    const timer = setTimeout(() => finish(scan()), options.waitMs);
  });
}
