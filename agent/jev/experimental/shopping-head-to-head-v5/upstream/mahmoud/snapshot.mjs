export const CANDIDATE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=menuitemcheckbox]",
  "[role=menuitemradio]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=combobox]",
  "[role=searchbox]",
  "[role=textbox]",
  "[role=option]",
  "summary",
  "[contenteditable=true]",
  "[onclick]",
].join(",");

export const ROLE_BY_TAG = {
  a: "link",
  button: "button",
  select: "combobox",
  textarea: "textbox",
  summary: "button",
  input: "textbox",
};

export function inputRole(el) {
  const type = (el.getAttribute("type") || "text").toLowerCase();
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
  if (type === "search") return "searchbox";
  if (type === "range") return "slider";
  return "textbox";
}

export function collectSnapshotInPage(args) {
  const { maxCandidates = 160, goalTokens = [], maxTextChars = 500, candidateSelector, roleByTag = {} } = args;
  const doc = document;
  const win = window;
  const st = (win.__jev ||= { map: new WeakMap(), byRef: new Map(), seq: 0, seen: new Set() });

  function inputRole(el) {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
    if (type === "search") return "searchbox";
    if (type === "range") return "slider";
    return "textbox";
  }

  const known = new Set(goalTokens.map((t) => String(t).toLowerCase()).filter(Boolean));
  const goalText = String(args.goal || "").toLowerCase();

  function refFor(el) {
    let ref = st.map.get(el);
    if (!ref) {
      ref = "e" + ++st.seq;
      st.map.set(el, ref);
      st.byRef.set(ref, el);
    }
    return ref;
  }

  function clean(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function labelOf(el) {
    const raw =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      (el.labels && el.labels[0] && el.labels[0].innerText) ||
      (el.tagName === "INPUT" && el.value) ||
      el.innerText ||
      el.getAttribute("name") ||
      el.getAttribute("data-testid") ||
      "";
    let label = clean(raw).slice(0, 90);
    if (label.length < 12) {
      const host = el.closest("tr,li,article,.card,section,[role=row],[role=listitem]");
      const ctx = host ? clean(host.innerText).slice(0, 64) : "";
      if (ctx) label = (label ? label + " — " : "") + ctx;
    }
    return label.slice(0, 96);
  }

  function visible(el) {
    if (typeof el.checkVisibility === "function") {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch {
        /* older chromium */
      }
    }
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    const s = win.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.pointerEvents === "none") return false;
    return true;
  }

  const candidates = Array.from(doc.querySelectorAll(candidateSelector));
  const candidateSet = new Set(candidates);

  const containers = new Set();
  for (const el of candidates) {
    let p = el.parentElement;
    let hops = 0;
    while (p && p !== doc.body && hops < 12) {
      if (candidateSet.has(p)) containers.add(p);
      p = p.parentElement;
      hops++;
    }
  }

  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const cx = vw / 2;
  const cy = vh / 2;
  const items = [];
  let skipped = 0;

  for (const el of candidates) {
    if (containers.has(el)) {
      const label = labelOf(el);
      const childSame = Array.from(el.children || []).some(
        (c) => candidateSet.has(c) && clean(labelOf(c)) === label
      );
      if (childSame || !label) {
        skipped++;
        continue;
      }
    }
    if (!visible(el)) {
      skipped++;
      continue;
    }

    if (el.tagName === "SELECT") {
      const selectRef = refFor(el);
      const rect = el.getBoundingClientRect();
      const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
      const selLabel = clean(
        el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("name") || "select"
      ).slice(0, 60);
      let oi = 0;
      for (const op of el.options || []) {
        const label = clean(op.textContent);
        if (!label || label === "choose…") {
          oi++;
          continue;
        }
        const oref = selectRef + "o" + oi;
        let score = 0;
        for (const t of label.toLowerCase().split(/[^a-z0-9@._-]+/i)) if (known.has(t)) score += 4;
        const ol = label.toLowerCase();
        for (const t of known) if (t.length >= 3 && ol.includes(t)) score += 2.5;
        score += 0.4;
        items.push({
          el,
          ref: oref,
          optionIndex: oi,
          tag: "option",
          role: "option",
          label,
          inSelect: selLabel,
          selected: !!op.selected,
          disabled: el.disabled,
          inView,
          rect,
          score,
          domIndex: items.length,
        });
        oi++;
      }
      continue;
    }

    const rect = el.getBoundingClientRect();
    const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    const tag = el.tagName.toLowerCase();
    let role = el.getAttribute("role") || roleByTag[tag] || "";
    if (tag === "input") role = inputRole(el);
    const label = labelOf(el);
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";

    const labelTokens = label.toLowerCase().split(/[^a-z0-9@._-]+/i).filter(Boolean);
    let score = 0;
    for (const t of labelTokens) if (known.has(t)) score += 4;
    const ll = label.toLowerCase();
    if (ll.length >= 3 && goalText.includes(ll)) score += 6;
    for (const t of known) if (t.length >= 3 && ll.includes(t)) score += 2.5;

    if (role === "button" || role === "link" || role === "tab" || role === "menuitem") score += 1.6;
    if (role === "textbox" || role === "searchbox" || role === "combobox") score += 1.4;
    if (role === "checkbox" || role === "radio" || role === "switch") score += 0.8;
    if (inView) score += 1.2;
    if (disabled) score -= 5;
    const dist = Math.hypot((rect.x + rect.width / 2 - cx) / Math.max(cx, 1), (rect.y + rect.height / 2 - cy) / Math.max(cy, 1));
    score -= dist * 0.8;
    if (rect.top >= 0 && rect.top < vh * 0.6) score += 0.3;
    if (el === doc.activeElement) score += 2;

    items.push({ el, ref: refFor(el), tag, role, label, disabled, inView, rect, score, domIndex: items.length });
  }

  items.sort((a, b) => b.score - a.score);
  const top = items.slice(0, maxCandidates);
  top.sort((a, b) => a.domIndex - b.domIndex);

  const elements = top.map((it) => {
    const flags = [];
    if (it.inView) flags.push("in-view");
    if (it.disabled) flags.push("DISABLED");
    if (it.el === doc.activeElement) flags.push("focused");
    if (it.inSelect) flags.push(`option of "${it.inSelect}"`);
    if (it.selected) flags.push("SELECTED");
    let value;
    if (it.tag === "input" || it.tag === "textarea") {
      const type = (it.el.getAttribute("type") || "text").toLowerCase();
      const textLike =
        it.tag === "textarea" || ["text", "email", "search", "url", "tel", "password", "number", "date", "time", "datetime-local", "month", "week"].includes(type);
      if (it.tag === "input" && !textLike) flags.push("type=" + type);
      if (it.el.checked) flags.push("checked");
      if (textLike && it.el.value) {
        if (type === "password") value = `<hidden:${it.el.value.length}>`;
        else value = clean(it.el.value).slice(0, 40);
        flags.push("filled");
      }
    }
    const r = it.rect;
    return {
      ref: it.ref,
      tag: it.tag,
      role: it.role,
      label: it.label,
      value,
      href: it.tag === "a" && it.el.getAttribute("href") ? clean(it.el.getAttribute("href")).slice(0, 70) : undefined,
      flags: flags.length ? flags : undefined,
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
    };
  });

  st.seen = new Set(elements.map((e) => e.ref));
  if (st.byRef.size > 4000) {
    for (const key of st.byRef.keys()) if (!st.seen.has(key)) st.byRef.delete(key);
  }

  let bodyText = "";
  try {
    bodyText = clean(doc.body ? doc.body.innerText : "").slice(0, maxTextChars);
  } catch {
    bodyText = "";
  }

  const focusRef = doc.activeElement && doc.activeElement !== doc.body ? st.map.get(doc.activeElement) || null : null;
  const dialogs = doc.querySelectorAll("dialog[open],[role=alertdialog],[role=dialog]").length;

  return {
    url: win.location.href,
    title: doc.title || "",
    dialogs,
    focusRef,
    scrollY: Math.round(win.scrollY),
    scrollHeight: doc.documentElement.scrollHeight,
    viewportH: vh,
    textSample: bodyText,
    count: items.length,
    skipped,
    truncated: items.length > maxCandidates,
    elements,
  };
}

export function stateFingerprintInPage() {
  const st = window.__jev || {};
  const doc = document;
  let text = "";
  try {
    text = String(doc.body ? doc.body.innerText : "").slice(0, 2000);
  } catch {
    text = "";
  }
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  let inputHash = 0;
  for (const el of doc.querySelectorAll("input,textarea,select")) {
    const v = String(el.value ?? "");
    for (let i = 0; i < v.length; i++) inputHash = (inputHash * 31 + v.charCodeAt(i)) | 0;
    inputHash = (inputHash * 33 + (el.checked ? 7 : 0)) | 0;
  }
  const active = doc.activeElement;
  return {
    url: location.href,
    title: doc.title || "",
    focusRef: active && active !== doc.body ? (st.map && st.map.get(active)) || null : null,
    dialogs: doc.querySelectorAll("dialog[open],[role=alertdialog],[role=dialog]").length,
    scrollY: Math.round(window.scrollY),
    textHash: hash,
    textLen: text.length,
    inputHash,
  };
}

export function formatElements(elements) {
  return elements
    .map((e) => {
      const parts = [`[${e.ref}] ${e.tag}`];
      if (e.role && e.role !== e.tag) parts.push(`(${e.role})`);
      parts.push(`"${e.label}"`);
      if (e.value != null) parts.push(`value="${e.value}"`);
      if (e.href) parts.push(`-> ${e.href}`);
      if (e.flags?.length) parts.push(`[${e.flags.join(",")}]`);
      return " " + parts.join(" ");
    })
    .join("\n");
}
