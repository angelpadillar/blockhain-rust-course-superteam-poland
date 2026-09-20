// Declared deterministic oracle for executor-only (offline) benchmark runs.
// It reads exactly the request a model would see — the goal, history and
// per-head candidate descriptions — and answers in the Jev response shape
// with synthetic probabilities. It encodes what a perfect picker would do;
// it does not measure model accuracy. Per-case logic lives in pick().

function synthesized(questions, atomId, valueKey) {
  const answers = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') { answers[id] = { type: 'noul', probability: id === 'destructive' ? 0.01 : 0.02 }; continue; }
    const keys = Object.keys(question.criteria);
    let choice = 'none' in question.criteria ? 'none' : keys[0];
    if (id === 'action') choice = atomId;
    else if (id === 'fill_value' && valueKey) choice = valueKey;
    const rest = keys.filter(k => k !== choice);
    const probabilities = { [choice]: 0.99 };
    for (const key of rest) probabilities[key] = 0.01 / Math.max(1, rest.length);
    answers[id] = { type: 'choice', choice, confidence: 0.99, probabilities };
  }
  return answers;
}

const text = value => String(value || '').toLowerCase();
const criteria = request => request.questions.action?.criteria || {};
function findAction(request, head, match) {
  const prefix = `${head}@`;
  for (const [id, description] of Object.entries(criteria(request))) {
    if (id.startsWith(prefix) && match(text(description))) return id;
  }
  return null;
}
const findRef = (request, head, match) => findAction(request, head, match)?.slice(head.length + 1) ?? null;
const filledValues = request => request.state.lastActions.filter(a => a.operation === 'fill' && /^filled/.test(a.outcome || '')).length;

function pickMerchantItem(request) {
  const last = request.state.lastActions.at(-1);
  const fills = filledValues(request);
  if (last?.operation === 'fill') {
    const ref = findRef(request, 'press', d => d.includes('search'));
    if (ref) return { operation: 'press', head: 'press', ref };
  }
  if (request.state.page.url.includes('/shop/') && fills === 1) {
    const ref = findRef(request, 'fill', d => d.includes('search'));
    if (ref) return { operation: 'fill', head: 'fill', ref, valueKey: 'item_query' };
  }
  if (fills === 0) {
    const ref = findRef(request, 'fill', d => d.includes('search'));
    if (ref) return { operation: 'fill', head: 'fill', ref, valueKey: 'shop_query' };
  }
  // Click the link matching the requested name; for the shop, prefer the
  // result inside the district named by the goal.
  const shopRef = findRef(request, 'click', d => d.includes('paper harbor') && d.includes('reference district'));
  const itemRef = findRef(request, 'click', d => d.includes('copper finch'));
  const ref = fills >= 2 ? itemRef || shopRef : shopRef || itemRef;
  if (ref) return { operation: 'click', head: 'click', ref };
  return { operation: 'wait' };
}

function pickVariantBag(request) {
  const added = request.state.lastActions.some(a => a.operation === 'click' && a.outcome === 'clicked');
  if (added) {
    const bag = findRef(request, 'click', d => d.includes('view bag'));
    if (bag) return { operation: 'click', head: 'click', ref: bag };
  }
  const ref = findRef(request, 'click', d => d.includes('kallax white 2x2'));
  if (ref) return { operation: 'click', head: 'click', ref };
  const bag = findRef(request, 'click', d => d.includes('view bag'));
  if (bag) return { operation: 'click', head: 'click', ref: bag };
  return { operation: 'wait' };
}

function pickTwoCheapest(request) {
  // Parse prices out of the same candidate descriptions the model sees and
  // add the two cheapest not yet added.
  const added = request.state.lastActions.filter(a => a.operation === 'click' && a.outcome === 'clicked').length;
  const bag = findRef(request, 'click', d => d.includes('view bag'));
  if (added >= 2 && bag) return { operation: 'click', head: 'click', ref: bag };
  const priced = Object.entries(criteria(request))
    .filter(([id, d]) => id.startsWith('click@') && /add to bag/i.test(d))
    .map(([id, d]) => ({ ref: id.slice(6), price: Number(d.match(/(\d+)\s*pln/i)?.[1] || Infinity) }))
    .sort((a, b) => a.price - b.price);
  if (priced[added]) return { operation: 'click', head: 'click', ref: priced[added].ref };
  return { operation: 'wait' };
}

function pickDeliveryForm(request) {
  const last = request.state.lastActions.at(-1);
  const filled = request.state.lastActions.filter(a => a.operation === 'fill' && a.outcome === 'filled').map(a => text(a.target));
  const sequence = [
    { match: d => d.includes('full name'), valueKey: 'fullname', target: 'full name' },
    { match: d => d.includes('street'), valueKey: 'street', target: 'street address' },
    { match: d => d.includes('city'), valueKey: 'town', target: 'city' },
  ];
  const next = sequence.find(item => !filled.some(t => t.includes(item.target.split(' ')[0])));
  if (next) {
    const ref = findRef(request, 'fill', next.match);
    if (ref) return { operation: 'fill', head: 'fill', ref, valueKey: next.valueKey };
  }
  const selected = request.state.lastActions.some(a => a.operation === 'select' && a.outcome === 'selected');
  if (!selected) {
    // Option descriptions read: choose "Standard courier" in select "…" —
    // match the chosen option name, not the select's label.
    const ref = findRef(request, 'select', d => /choose "standard courier"/i.test(d));
    if (ref) return { operation: 'select', head: 'select', ref };
  }
  if (last?.operation !== 'click') {
    const ref = findRef(request, 'click', d => d.includes('save and review'));
    if (ref) return { operation: 'click', head: 'click', ref };
  }
  return { operation: 'wait' };
}

const PICKERS = { 'merchant-item': pickMerchantItem, 'variant-bag': pickVariantBag,
  'two-cheapest': pickTwoCheapest, 'delivery-form': pickDeliveryForm };

export function createOracle(caseId) {
  const pick = PICKERS[caseId];
  if (!pick) throw new Error('unknown_oracle_case');
  return async function decide(request) {
    const choice = pick(request);
    const atomId = choice.ref ? `${choice.head}@${choice.ref}` : choice.operation;
    return synthesized(request.questions, atomId, choice.valueKey);
  };
}
