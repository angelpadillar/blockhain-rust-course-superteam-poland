import { createHash } from 'node:crypto';
// Read rendered Delio cart/checkout markup only. Page scripts, account fields,
// cookies and hidden JSON are never exported. Unknown structure yields explicit
// parse gaps, never guessed quantities or totals.
const decode = s => String(s || '').replace(/&(?:amp|quot|apos|lt|gt|nbsp);|&#(?:x[0-9a-f]+|[0-9]+);/gi, x => {
  const named = {'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>','&nbsp;':' '};
  if(named[x])return named[x]; const n=x[2]==='x'?parseInt(x.slice(3),16):parseInt(x.slice(2),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
});
export const text = s => decode(String(s).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
export const plnMinor = s => {
  const m = text(s).match(/^(-|−)?\s*(\d+(?:[ .]\d{3})*)[,.](\d{2})\s*zł$/);
  if(!m)return null;
  const v = Number(m[2].replace(/[ .]/g,'')+'.'+m[3])*(m[1]?-1:1);
  return Number.isSafeInteger(Math.round(v*100)) ? Math.round(v*100) : null;
};
const strip = html => String(html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
const PRODUCT = /href="\/products\/(A\d{7})-[^"?#]*"/g;

// Cart lines: one block per product anchor. Quantity is accepted only from an
// explicit stepper/input pattern inside the same block; anything else is a gap.
export function cartLines(html, { maxSpan = 14000 } = {}) {
  if(typeof html !== 'string' || html.length > 2_100_000) throw new Error('cart_markup_invalid');
  const clean = strip(html);
  const matches = [...clean.matchAll(PRODUCT)];
  const lines = [], gaps = [], seen = new Set(), titles = {};
  for (let i = 0; i < matches.length; i++) {
    const id = matches[i][1];
    // Anchors inside a product-tile are catalogue/recommendation cards, never
    // cart lines — the drawer renders its own promo grid with the same tiles.
    const before = clean.slice(Math.max(0, matches[i].index - 5000), matches[i].index);
    if (new RegExp(`data-testid="product-tile-${id}-`).test(before)) continue;
    // A line anchors its product twice (image + title); the second anchor is
    // a sibling inside the same <li>, not a duplicate line.
    if (seen.has(id)) continue;
    const next = matches.slice(i + 1).find(m => m[1] !== id);
    const end = Math.min(next ? next.index : clean.length, matches[i].index + maxSpan);
    const block = clean.slice(matches[i].index, end);
    const quantity = blockQuantity(block);
    if (quantity === null) { gaps.push(id); continue; }
    seen.add(id);
    const label = block.match(/aria-label="(?:Usuń z koszyka|Zmniejsz ilość|Dodaj do koszyka): ([^"]+)"/);
    if (label) titles[id] = label[1];
    lines.push({ productId: id, quantity });
  }
  return { lines, titles, unparsedLines: gaps.length };
}

// Snapshot-driven cart reader. The drawer's own markup can sit past the
// serialized-HTML limit, so cart lines are read from the accessibility tree:
// a product link plus its named controls ("Usuń z koszyka: <title>",
// "Zmniejsz ilość: <title>", "Dodaj do koszyka: <title>"). Promo tiles expose
// only an add control and are never lines. Quantity is read from the full
// snapshot's adjacent static text; unverifiable quantities are gaps.
const CONTROL = [
  ['decrease', /^Zmniejsz ilość: (.+)$/s],
  ['remove', /^Usuń z koszyka: (.+)$/s],
  ['increase', /^Dodaj do koszyka: (.+)$/s]
];
export function cartLinesSnapshot(fullElements, interactiveElements) {
  const full = Array.isArray(fullElements) ? fullElements : [];
  const inter = Array.isArray(interactiveElements) ? interactiveElements : [];
  const links = [], controls = [];
  inter.forEach((e, index) => {
    const name = String(e.name || '');
    if (e.role === 'link') {
      const m = String(e.href || '').match(/^\/products\/(A\d{7})-/);
      if (m) links.push({ productId: m[1], title: name.split('\n')[0].trim(), index });
      return;
    }
    if (e.role !== 'button' || typeof e.ref !== 'string') return;
    for (const [kind, re] of CONTROL) {
      const m = name.match(re);
      if (m) { controls.push({ kind, title: m[1].trim(), ref: e.ref, index }); break; }
    }
  });
  const lines = [], gaps = [], seen = new Set(), byTitle = new Map();
  for (const link of links) {
    if (seen.has(link.productId)) continue;
    const own = controls.filter(c => c.title === link.title);
    if (!own.some(c => c.kind === 'remove') || !own.some(c => c.kind !== 'remove')) continue; // promo tile
    if (byTitle.has(link.title)) { gaps.push(link.productId); continue; }
    byTitle.set(link.title, true); seen.add(link.productId);
    const nearest = kind => own.filter(c => c.kind === kind).sort((a, b) => Math.abs(a.index - link.index) - Math.abs(b.index - link.index))[0]?.ref || null;
    const quantity = lineQuantity(full, link);
    lines.push({ productId: link.productId, title: link.title, quantity,
      controls: { increase: nearest('increase'), decrease: nearest('decrease'), remove: nearest('remove') } });
  }
  lines.sort((a, b) => a.productId.localeCompare(b.productId));
  return { lines: lines.filter(l => l.quantity !== null).map(({ productId, quantity }) => ({ productId, quantity })),
    controls: Object.fromEntries(lines.map(l => [l.productId, l.controls])),
    titles: Object.fromEntries(lines.map(l => [l.productId, l.title])),
    gaps: [...gaps, ...lines.filter(l => l.quantity === null).map(l => l.productId)] };
}
function lineQuantity(full, link) {
  // The quantity readout sits between the stepper controls as static text.
  // Match by name/href position in the full tree, then scan a short window.
  const at = full.findIndex(e => e.role === 'link' && String(e.href || '').startsWith(`/products/${link.productId}-`));
  if (at < 0) return null;
  for (let i = at + 1; i < Math.min(full.length, at + 14); i++) {
    const e = full[i];
    if (e.role === 'link' || e.role === 'button') {
      const n = String(e.name || '');
      if (/Zmniejsz ilość|Dodaj do koszyka|Usuń z koszyka/.test(n)) continue;
      break;
    }
    const n = String(e.name || e.text || '').trim();
    const m = n.match(/^(\d{1,3})(?:\s*(?:szt\.?|sztuka|sztuki|sztuk|x|×))?$/i) || n.match(/^(?:Ilość|Liczba)[^0-9]{0,8}(\d{1,3})/i);
    if (m) { const q = Number(m[1]); if (q >= 1 && q <= 999) return q; }
  }
  return null;
}
function blockQuantity(block) {
  // The merchant's in-cart counter test id is deterministic.
  const testid = block.match(/data-testid="CartCounter__quantity-in-active-cart"[^>]*>\s*(\d{1,3})\s*</);
  if (testid) return Number(testid[1]);
  // Explicit quantity input value.
  const input = block.match(/<input\b[^>]*(?:aria-label="[^"]*(?:ilość|quantity)[^"]*"|inputmode="numeric"|name="[^"]*quantity[^"]*")[^>]*>/i);
  if (input) {
    const v = input[0].match(/value="(\d{1,3})"/);
    if (v) { const q = Number(v[1]); if (Number.isSafeInteger(q) && q >= 1 && q <= 999) return q; }
  }
  // Stepper readout such as <span ...>2</span> between +/- controls, or an
  // aria-label like "Ilość: 2" / "2 szt.".
  const aria = block.match(/aria-label="(?:Ilość|Liczba sztuk|Quantity)[^0-9]{0,12}(\d{1,3})"/i);
  if (aria) { const q = Number(aria[1]); if (q >= 1 && q <= 999) return q; }
  const szt = block.match(/>(\d{1,3})\s*szt\.?\s*</);
  if (szt) { const q = Number(szt[1]); if (q >= 1 && q <= 999) return q; }
  return null;
}

// Stepper control refs per line, read from the interactive snapshot. Buttons
// only; every mapping must be unambiguous or it is reported absent.
export function stepperRefs(snapshot, productIds) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : [];
  const result = {};
  for (const id of productIds) {
    // A line's controls are labelled with the product context in Delio markup,
    // e.g. "Zwiększ ilość: <title>" — matched by the product anchor order below.
    result[id] = { increase: null, decrease: null };
  }
  return result;
}

// Summary rows in the cart drawer or checkout: labelled zł amounts.
export function summaryRows(html) {
  const clean = strip(html);
  const rows = [];
  for (const m of clean.matchAll(/>([^<>]{2,60})<[^>]*>\s*(?:<[^>]*>){0,3}[^<]*?(\d+(?:[ .]\d{3})*[,.]\d{2}\s*zł)/g)) {
    const label = text(m[1]), minor = plnMinor(m[2]);
    if (label && minor !== null) rows.push({ label: label.slice(0, 80), amountMinor: minor });
  }
  return rows.slice(0, 40);
}

// Coupon evidence in cart/checkout markup: the configured code or its campaign
// title with a neighbouring discount row or activation state.
export function couponObservation(html, expectedCode) {
  if (typeof expectedCode !== 'string' || !expectedCode) return { observed: false };
  const clean = strip(html), lower = clean.toLowerCase(), code = expectedCode.toLowerCase();
  const at = lower.indexOf(code);
  if (at < 0) return { observed: false };
  const near = text(clean.slice(Math.max(0, at - 1500), at + 1500));
  const amount = near.match(/(\d+(?:[ .]\d{3})*[,.]\d{2})\s*zł/g);
  return { observed: true, nearbyText: near.slice(0, 300), nearbyAmounts: amount || [],
    activeHint: /aktywn|aktywowan|zastosowan|wykorzystan/i.test(near) || null };
}

export function productPaths(html) {
  const clean = strip(html), map = {};
  for (const m of clean.matchAll(/href="(\/products\/(A\d{7})-[^"?#]*)"/g)) map[m[2]] ||= m[1];
  return map;
}
export const artifactHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
