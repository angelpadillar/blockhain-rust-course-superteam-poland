const $ = selector => document.querySelector(selector);
let state, busy = false, requestError = '';
const money = minor => `${(minor / 100).toFixed(2)} PLN`;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const messages = {
  happy: 'Everything matches. Approve this exact quote, then run the simulated final check.',
  price_increase: 'After approval, this scenario raises the fresh quote by 6.00 PLN. The original approval must not carry over.',
  merchant_mismatch: 'After approval, this scenario swaps the merchant. The authorization check must reject it.',
  expired: 'This scenario advances the demo clock beyond the quote expiry. Approval must be rejected.',
  replay: 'Complete the simulated order once, then try the same approval again. It must be rejected.',
};
const reasons = {
  quote_expired: 'Stopped: this quote expired. Capture and review a new quote before continuing.',
  price_or_quote_changed: 'Stopped: the total changed to 35.90 PLN after approval. Your 29.90 PLN approval was not reused.',
  merchant_or_item_mismatch: 'Stopped: the fresh merchant no longer matches your approved gift. Nothing was executed.',
  approval_already_consumed: 'Stopped: this approval was already used. The repeated attempt produced no second execution.',
  quote_hash_mismatch: 'Stopped: the submitted approval does not match this exact quote.',
  approval_required: 'Stopped: the exact quote has not been approved.',
  review_required_after_rejection: 'Stopped: start a fresh review after a rejected attempt.',
  approval_already_exists: 'Stopped: this quote already has an approval.',
};
function render() {
  if (!state) return;
  const rejected = Boolean(state.rejection), approved = Boolean(state.approval), confirmed = Boolean(state.confirmation);
  $('#total').textContent = money(state.quote.totalMinor);
  $('#subtotal').textContent = money(state.quote.items[0].unitPriceMinor * state.quote.items[0].quantity);
  $('#fees').textContent = money(state.quote.feesMinor);
  $('#quote-hash').textContent = state.quoteHash;
  $('#mandate-id').textContent = state.quote.mandateId;
  $('#exact-expiry').textContent = new Date(state.quote.expiresAt).toISOString();
  $('#expiry').textContent = state.now >= state.quote.expiresAt ? 'Quote expired' : `Valid until ${new Date(state.quote.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  const labels = { review: 'Awaiting review', approved: 'Exact quote approved', confirmed: 'Simulated confirmation', rejected: 'Attempt rejected' };
  $('#status-badge').textContent = labels[state.status]; $('#status-badge').className = `badge ${state.status}`;
  $('#notice').className = `notice${rejected ? ' error' : confirmed ? ' success' : ''}`;
  $('#notice').textContent = requestError || (rejected ? reasons[state.rejection.reason] || `Stopped: ${state.rejection.reason}`
    : confirmed ? `Simulated confirmation ${state.confirmation.orderId}. No real order or payment was made.`
      : approved ? 'Exact quote approved. The final check will compare fresh merchant details before a single simulated execution.' : messages[state.scenario]);
  if (requestError) $('#notice').className = 'notice error';
  $('#approve').hidden = approved || rejected;
  $('#approve').disabled = busy;
  $('#approve').innerHTML = `Approve exact quote · ${money(state.quote.totalMinor)} <span>→</span>`;
  $('#execute').hidden = !approved || rejected;
  $('#execute').disabled = busy;
  $('#execute').innerHTML = confirmed ? 'Test a repeat attempt <span>↻</span>' : 'Check & simulate order <span>→</span>';
  $('#button-note').textContent = rejected ? 'This attempt is recorded. Select a scenario to begin a new review.'
    : confirmed ? 'Confirmation is a local simulation, not evidence of merchant fulfillment.' : 'Approval is recorded locally. It is not a payment or wallet signature.';
  document.querySelectorAll('[data-scenario]').forEach(button => { button.classList.toggle('selected', button.dataset.scenario === state.scenario); button.disabled = busy; });
  const rows = [
    ['Gift prepared', 'Exact item, quantity, merchant and full price.', 'complete'],
    ['You approve the quote', approved ? 'Approval is bound to the displayed quote hash.' : 'Review the details before authorizing this quote.', approved ? 'complete' : rejected ? 'failed' : 'current'],
    ['Fresh details checked', state.observedQuote ? rejected ? 'The mismatch was rejected before execution.' : 'Merchant, price and expiry still match.' : 'A changed or expired quote cannot continue.', state.observedQuote ? rejected ? 'failed' : 'complete' : ''],
    ['One simulated execution', confirmed ? 'One local confirmation recorded. No real payment.' : 'An approval can authorize at most one attempt.', confirmed ? 'complete' : ''],
  ];
  $('#timeline').innerHTML = rows.map(([title, text, status], i) => `<div class="timeline-row ${status}"><div class="step-dot">${status === 'complete' ? '✓' : status === 'failed' ? '!' : i + 1}</div><div class="step-text"><strong>${escape(title)}</strong><p>${escape(text)}</p></div></div>`).join('');
  const integrity = state.verification.integrityValid ?? state.verification.valid;
  $('#integrity-text').textContent = integrity ? 'Local record chain is intact' : 'Record integrity check failed';
  $('.integrity').classList.toggle('invalid', !integrity);
  $('#record-count').textContent = `${state.chain.length} linked records · SHA-256 · ${state.verification.boundaryComplete ? 'boundary captures attached' : 'boundary screenshots not attached'}`;
  $('#event-trail').innerHTML = state.chain.map(entry => { const record = entry.record || entry; return `<li>${escape(record.type)}${record.reason ? ` · ${escape(record.reason)}` : ''}</li>`; }).join('');
}
async function act(action, payload) {
  if (busy) return; busy = true; requestError = ''; render();
  try {
    const response = await fetch(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!result.state) throw new Error(result.error || 'Request failed');
    state = result.state;
  } catch { requestError = 'The local request could not be recorded. No approval or execution is assumed; reload to check the saved state.'; }
  finally { busy = false; render(); }
}
$('#approve').addEventListener('click', () => act('approve', { quoteHash: state.quoteHash }));
$('#execute').addEventListener('click', () => act('execute', {}));
document.querySelectorAll('[data-scenario]').forEach(button => button.addEventListener('click', () => act('reset', { scenario: button.dataset.scenario })));
fetch('/api/state').then(response => response.json()).then(value => { state = value; render(); }).catch(() => { $('#notice').textContent = 'Start the local demo server to load a quote.'; });
