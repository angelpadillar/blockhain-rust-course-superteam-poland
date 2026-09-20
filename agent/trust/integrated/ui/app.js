const $ = (id) => document.getElementById(id);
let state = {};
let busy = 'Loading the local demo';
const errors = [];

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const list = (value) => Array.isArray(value) ? value : [];
const pretty = (value) => JSON.stringify(value ?? {}, null, 2);
const money = (minor, currency = 'PLN') => Number.isSafeInteger(minor)
  ? `${new Intl.NumberFormat('en-GB', {minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2}).format(minor / 100)} ${text(currency, 'PLN')}` : 'Awaiting quote';
const date = (value) => {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null;
  const result = new Date(numeric === null ? value : numeric < 1e12 ? numeric * 1000 : numeric);
  return Number.isFinite(result.getTime()) ? result : null;
};
const time = (value) => date(value)?.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit', second:'2-digit'}) ?? '—';
const humanize = (value) => text(value).replace(/[_-]+/g, ' ').replace(/^./, (char) => char.toUpperCase());
const confirmed = () => state.authorization?.confirmed === true && Boolean(state.quote?.termsHash) && state.authorization.termsHash === state.quote.termsHash;

function errorMessage(code, detail) {
  const known = {
    checkout_changed:'Checkout changed from the approved purchase. Stop and request a new approval; no order was submitted.',
    replay_rejected_by_program:'Solana rejected the repeated authorization. The original order remains verified and no second order was sent.',
    confirmed_mandate_required:'A confirmed Solana mandate is required before execution. An interface approval flag cannot authorize the gift.',
    approval_evidence_incomplete:'Required approval evidence is missing, so execution has stopped.',
    chain_outcome_requires_reconciliation:'The authorization response is uncertain. Inspect the existing attempt before doing anything else.',
    reconcile_existing_run_first:'Finish reconciling the existing attempt before starting a new story.',
    no_matching_order:'No matching merchant order was found. The consumed authorization stays stopped for operator review.',
    price_changed:'The checkout price changed. The approved amount remains unchanged, and execution was blocked.',
    quote_mismatch:'The checkout no longer matches the approved terms. Execution was blocked.',
    terms_mismatch:'The submitted approval does not match the current quote.',
    already_executed:'A second execution was rejected. The first result is retained.',
    mandate_consumed:'This authorization has already been used. A second execution was rejected.',
    replay_rejected:'The local contract rejected the replay. The original result is retained.',
    needs_reconciliation:'The merchant reply is uncertain. Check for an existing order before doing anything else.',
    quote_expired:'This quote has expired. Start a fresh demo to request a new quote.',
    network_error:'The local server could not be reached. The last known state is preserved; no automatic retry was made.',
    invalid_response:'The local server returned an unreadable response. The last known state is preserved.',
  };
  return known[code] || (typeof detail === 'string' && detail ? detail.slice(0, 700) : `The request was not completed${code ? `: ${humanize(code).toLowerCase()}` : ''}.`);
}

function retainError(code, detail) {
  errors.push({at:new Date().toISOString(), runId:state.runId || null, code:text(code, 'request_failed'), message:errorMessage(code, detail)});
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials:'same-origin', cache:'no-store',
      ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}),
    });
  } catch { throw Object.assign(new Error('network_error'), {code:'network_error'}); }
  let payload;
  try { payload = await response.json(); }
  catch { throw Object.assign(new Error('invalid_response'), {code:'invalid_response'}); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Object.assign(new Error('invalid_response'), {code:'invalid_response'});
  if (payload.state && typeof payload.state === 'object' && !Array.isArray(payload.state)) state = payload.state;
  if (!response.ok || payload.ok === false) {
    retainError(payload.code || `http_${response.status}`, typeof payload.error === 'string' ? payload.error : payload.error?.message);
    return false;
  }
  if (body === undefined && path === '/api/state') state = payload.state ?? payload;
  return true;
}

function statusMessage() {
  if (busy) return {tone:'busy', message:`${busy}…`};
  if (!state.runId) return {tone:'error', message:'The demo is not ready. Choose a story to prepare a fresh run.'};
  if (state.phase === 'completed' && state.verification?.ok === true) return {tone:'success', message:'Gift verified in the simulated merchant. The local transaction and evidence are available below.'};
  if (state.phase === 'completed') return {tone:'warning', message:'Execution is recorded. Independent verification has not confirmed the outcome.'};
  if (state.phase === 'needs_reconciliation') return {tone:'warning', message:'The reply is uncertain. Check the existing order; do not place another one.'};
  if (state.phase === 'blocked') return {tone:'warning', message:'Execution was blocked. Review the recorded reason and the approved terms below.'};
  if (state.phase === 'approved' && confirmed()) return {tone:'success', message:'The local Solana authorization is confirmed. Merchant execution is a separate next step.'};
  if (state.phase === 'approved') return {tone:'warning', message:'Approval is recorded. A matching local chain authorization is still required before execution.'};
  return {tone:'neutral', message:'The quote is ready. Review the gift and exact amount before approving.'};
}

function renderStatus() {
  const status = statusMessage();
  $('status').dataset.tone = status.tone;
  $('status').innerHTML = `<span class="status-dot" aria-hidden="true"></span><span>${escape(status.message)}</span>`;
  $('errors').innerHTML = errors.length ? `<details class="error-history" open><summary>${errors.length === 1 ? 'A request was stopped or failed' : `${errors.length} stopped or failed requests`} · retained for review</summary><ol>${errors.map((entry) => `<li>${escape(entry.message)}<small>${escape(time(entry.at))} · ${escape(humanize(entry.code))}${entry.runId && entry.runId !== state.runId ? ' · previous demo run' : ''}</small></li>`).join('')}</ol></details>` : '';
}

function renderGift() {
  const recipient = state.recipient || {};
  const recommendation = state.recommendation || {};
  const quote = state.quote || {};
  $('recipient-heading').textContent = `For ${text(recipient.name, 'Marta')}`;
  $('recipient-brief').textContent = text(recipient.brief, 'Marta enjoys coffee, pour-over brewing and cycling.');
  $('gift-heading').textContent = text(recommendation.name, text(quote.item, 'Weekend Coffee Discovery Set'));
  $('gift-merchant').textContent = text(quote.merchant, 'Kraków Coffee Lab — demo');
  $('gift-price').textContent = money(quote.totalMinor ?? 12900, quote.currency || 'PLN');
  $('gift-reason').textContent = text(recommendation.reason, 'A coffee discovery set fits Marta’s interest in pour-over brewing and a slower weekend ritual.');
  const evidence = list(recommendation.evidence);
  $('recommendation-evidence').innerHTML = `<details><summary>Why this fits Marta</summary>${evidence.length ? evidence.map((item) => `<p><strong>${escape(item.label || 'Recipient brief')}</strong><br>${escape(item.text || '')}</p><p class="evidence-source">${escape(item.source || 'Supplied fictional recipient brief')}</p>`).join('') : '<p>Her supplied fictional brief mentions coffee and pour-over brewing. This recommendation uses that demo context.</p>'}<p class="evidence-source">Recipient evidence is fictional and supplied for this demo.</p></details>`;
}

function renderApproval() {
  const quote = state.quote || {};
  const observed = state.observedQuote || {};
  const execution = state.execution || {};
  const hasQuote = Number.isSafeInteger(quote.totalMinor) && Boolean(quote.termsHash);
  const approved = confirmed();
  const changed = Number.isSafeInteger(observed.totalMinor) && (observed.totalMinor !== quote.totalMinor || observed.currency !== quote.currency);
  const expires = date(quote.expiresAt);
  const expired = expires ? expires.getTime() <= Date.now() : false;
  let outcome = '';
  let actions = '';
  if (state.phase === 'quoted') {
    actions = `<button class="primary-button" data-command="approve" ${!hasQuote || expired ? 'disabled' : ''}>Approve exactly ${escape(money(quote.totalMinor, quote.currency))}<span class="button-arrow" aria-hidden="true">→</span></button><p class="action-caption">This button records your approval and requests a transaction from the ephemeral demo signer. Confirmation is shown only after the local chain responds. No real wallet or payment is involved.</p>`;
  } else if (state.phase === 'approved') {
    outcome = approved ? '<div class="outcome-box success"><h3>Local authorization confirmed</h3><p>Your approval is bound to these exact terms. Merchant execution has not happened yet.</p></div>' : '<div class="outcome-box warning"><h3>Waiting for matching authorization</h3><p>UI approval alone is not chain confirmation. Execution stays unavailable until the local authorization confirms these terms.</p></div>';
    actions = `<button class="primary-button" data-command="execute" ${!approved ? 'disabled' : ''}>${changed ? 'Check changed checkout' : 'Execute simulated gift'}<span class="button-arrow" aria-hidden="true">→</span></button><p class="action-caption">${changed ? 'The executor rechecks checkout against the signed terms before submitting an attempt. A changed price requires new approval.' : 'The fixture receives a simulated order only after its authorization checks. No real merchant purchase is made.'}</p>`;
  } else if (state.phase === 'needs_reconciliation') {
    outcome = '<div class="outcome-box warning"><h3>A missing reply is not a failed purchase</h3><p>The fixture may already have accepted the order. Reconcile the existing attempt before considering another action.</p></div>';
    actions = '<button class="primary-button" data-command="reconcile">Check the existing order<span class="button-arrow" aria-hidden="true">→</span></button><p class="action-caption">Reconciliation looks for the existing simulated order. It does not dispatch a second purchase.</p>';
  } else if (state.phase === 'completed') {
    outcome = state.verification?.ok === true ? '<div class="outcome-box success"><h3>The simulated gift is verified</h3><p>Independent checks confirmed the recorded fixture outcome. Review those checks and local transaction evidence below.</p></div>' : '<div class="outcome-box warning"><h3>Execution recorded; verification incomplete</h3><p>A completed execution does not by itself prove the intended outcome. Review the independent checks below.</p></div>';
    actions = '<button class="secondary-button" data-command="execute">Test duplicate protection <span aria-hidden="true">↻</span></button><p class="action-caption">Submits a fresh replay transaction to the local contract. Its rejection is recorded; the original outcome remains visible.</p>';
  } else if (state.phase === 'blocked') {
    const detail = typeof state.error === 'string' ? errorMessage(state.error) : state.error?.message;
    outcome = `<div class="outcome-box warning"><h3>Stopped before an unauthorized step</h3><p>${escape(detail || 'The request did not pass its checks. The approved terms have not been expanded. Review the event and transaction evidence for the exact reason.')}</p></div>`;
    actions = '<p class="action-caption">Choose a story above to begin a fresh run. This blocked run remains available in its evidence.</p>';
  } else {
    actions = '<p class="muted">Preparing the quote and local chain state…</p>';
  }
  $('approval').innerHTML = `<div class="card-heading"><span class="section-number">03 / YOUR PERMISSION</span><span class="small-tag">${approved ? 'Terms authorized' : 'Exact terms'}</span></div><h2 id="approval-heading">One gift. One approval.</h2><p class="muted">${approved ? 'The amount you authorized' : 'The amount you are being asked to approve'}</p><div class="quote-price">${hasQuote ? escape(money(quote.totalMinor, quote.currency).replace(` ${quote.currency || 'PLN'}`, '')) : '—'} <small>${escape(quote.currency || 'PLN')}</small></div><p class="price-caption">${approved ? 'Approved total · fixed to this quote' : 'Quoted total · no permission to exceed it'}</p>${changed ? `<div class="price-comparison"><div><span>${approved ? 'Approved' : 'Quoted'}</span><strong>${escape(money(quote.totalMinor, quote.currency))}</strong></div><div><span>Current checkout</span><strong>${escape(money(observed.totalMinor, observed.currency))}</strong></div></div>` : ''}<dl class="quote-facts"><div><dt>Merchant</dt><dd>${escape(quote.merchant || 'Kraków Coffee Lab — demo')}</dd></div><div><dt>Quantity</dt><dd>${escape(quote.quantity ?? '—')}</dd></div><div><dt>Quote valid until</dt><dd>${expires ? `${escape(time(quote.expiresAt))}${expired && state.phase === 'quoted' ? ' · expired' : ''}` : 'Awaiting quote'}</dd></div>${execution.dispatchCount !== undefined ? `<div><dt>Merchant dispatches</dt><dd>${escape(execution.dispatchCount)}</dd></div>` : ''}</dl>${outcome}<div class="action-stack">${actions}</div><details class="terms-details"><summary>Inspect the exact approval binding</summary><p>Quote terms hash</p><code>${escape(quote.termsHash || 'Not yet recorded')}</code><p>Local authorization terms hash</p><code>${escape(state.authorization?.termsHash || 'Not yet confirmed')}</code><p>Authorization state: ${escape(humanize(state.authorization?.status) || 'Awaiting approval')}. A matching hash binds permission to this quote.</p></details>`;
}

function renderJourney() {
  const authorization = confirmed();
  const attempted = Boolean(state.execution?.attemptId) || ['completed','needs_reconciliation'].includes(state.phase);
  const completed = state.phase === 'completed';
  const verified = state.verification?.ok === true;
  const uiApproved = authorization || state.phase === 'approved' || attempted;
  const steps = [
    {label:'Exact amount approved', done:uiApproved, current:state.phase === 'quoted', detail:uiApproved ? `${money(state.quote?.totalMinor, state.quote?.currency)} · permission for this quote` : 'Your click gives permission for the displayed terms.'},
    {label:'Local chain authorization', done:authorization, current:uiApproved && !authorization, detail:authorization ? 'Confirmed by LiteSVM using the ephemeral demo signer.' : 'A real transaction in a local Solana environment.'},
    {label:'Simulated merchant execution', done:completed, current:authorization && !completed, detail:state.phase === 'needs_reconciliation' ? 'Reply uncertain. Check the existing order.' : attempted ? `Recorded dispatches: ${state.execution?.dispatchCount ?? 'unavailable'}.` : 'A separate action, checked against the approved terms.'},
    {label:'Independent outcome verified', done:verified, current:completed && !verified, detail:verified ? 'Fixture checks passed; inspect each result below.' : 'A “completed” response alone is not proof.'},
  ];
  $('journey').innerHTML = steps.map((step, i) => `<li class="${step.done ? 'done' : step.current ? 'current' : ''}"><span class="journey-icon" aria-hidden="true">${step.done ? '✓' : i + 1}</span><div><strong>${escape(step.label)}</strong><p>${escape(step.detail)}</p></div></li>`).join('');
}

function renderEvidence() {
  const verification = state.verification || {};
  const checks = list(verification.checks);
  $('verification-badge').textContent = verification.ok === true ? 'Passed' : checks.length ? 'Not confirmed' : 'Pending';
  $('verification-badge').className = `small-tag${verification.ok === true ? ' green-tag' : ''}`;
  $('verification').innerHTML = checks.length ? `<ul class="check-list">${checks.map((check) => `<li><div class="check-label"><span class="check-symbol ${check.passed === true ? 'passed' : check.passed === false ? 'failed' : ''}" aria-label="${check.passed === true ? 'Passed' : check.passed === false ? 'Failed' : 'Pending'}">${check.passed === true ? '✓' : check.passed === false ? '×' : '·'}</span><span>${escape(check.label || 'Outcome check')}</span></div>${check.actual !== undefined || check.expected !== undefined ? `<details><summary>View observed and expected values</summary><pre>${escape(pretty({actual:check.actual, expected:check.expected}))}</pre></details>` : ''}</li>`).join('')}</ul>` : '<p class="empty-state">After execution, independent checks compare the simulated merchant’s recorded outcome with the approved gift. No success is assumed in advance.</p>';
  $('run-id').textContent = state.runId ? `Run ${String(state.runId).slice(0, 10)}` : 'Starting';
  $('run-id').title = text(state.runId);
  const events = list(state.events);
  $('activity').innerHTML = events.length ? [...events].reverse().map((event) => `<li><time datetime="${escape(date(event.at)?.toISOString() || '')}">${escape(time(event.at))}</time><div><p>${escape(event.message || humanize(event.type) || 'Event recorded')}</p><small>${escape(humanize(event.type))}</small></div></li>`).join('') : '<li><span></span><p class="muted">Events will appear as the demo progresses.</p></li>';
  const transactions = list(state.chain?.transactions);
  $('technical-evidence').innerHTML = `<details class="technical-detail"><summary>Local Solana transactions <span>${transactions.length} recorded · no public network</span></summary>${transactions.length ? transactions.map((tx) => {
    const success = tx.success ?? tx.accepted;
    return `<div class="tx-item"><div class="tx-topline"><strong>${escape(tx.label || 'Local transaction')}</strong><span class="tx-result ${success === false ? 'failed' : success === true ? '' : 'unknown'}">${success === true ? 'Confirmed locally' : success === false ? 'Rejected locally' : 'Recorded'}</span></div><code>${escape(tx.signature || 'Signature unavailable')}</code>${tx.computeUnits !== undefined ? `<p class="muted">Compute units: ${escape(tx.computeUnits)}</p>` : ''}${tx.error ? `<pre>${escape(typeof tx.error === 'string' ? tx.error : pretty(tx.error))}</pre>` : ''}<details><summary>Transaction logs</summary><pre>${escape(Array.isArray(tx.logs) ? tx.logs.join('\n') : text(tx.logs, 'No logs recorded.'))}</pre></details></div>`;
  }).join('') : '<p class="empty-state">Actual local transaction signatures and logs will appear here. They are not public-chain transactions.</p>'}</details><details class="technical-detail"><summary>Authorization and account state <span>Recorded local state</span></summary><pre>${escape(pretty({authorization:state.authorization || {}, accountState:state.chain?.accountState || {}}))}</pre></details><details class="technical-detail"><summary>Execution and evidence record <span>Attempt, order and artifact bindings</span></summary><pre>${escape(pretty({runId:state.runId || null, execution:state.execution || {}, evidence:state.evidence || {}}))}</pre></details>`;
  renderArtifacts();
}

function artifactURL(artifact) {
  const raw = artifact.url || artifact.path;
  if (typeof raw !== 'string' || !raw || raw.startsWith('//')) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin || !['http:','https:'].includes(url.protocol) || url.username || url.password || !url.pathname.startsWith('/artifacts/')) return null;
    return url.href;
  } catch { return null; }
}

function renderArtifacts() {
  $('artifacts').innerHTML = list(state.evidence?.artifacts).filter((artifact) => artifact && typeof artifact === 'object').map((artifact) => {
    const url = artifactURL(artifact);
    const name = artifact.label || artifact.name || humanize(artifact.stage) || 'Recorded artifact';
    const screenshot = artifact.kind === 'screenshot' || /^image\//.test(artifact.mimeType || '') || /\.(png|jpe?g|webp)(\?|$)/i.test(url || '');
    return `<article class="artifact-card">${url && screenshot ? `<a href="${escape(url)}" target="_blank" rel="noopener"><img src="${escape(url)}" alt="${escape(name)}" loading="lazy"></a>` : ''}<h3>${escape(name)}</h3>${url ? `<a href="${escape(url)}" target="_blank" rel="noopener">Open recorded artifact ↗</a>` : '<p>Artifact metadata recorded. No served preview is available.</p>'}${artifact.sha256 || artifact.hash ? `<code>SHA-256 ${escape(artifact.sha256 || artifact.hash)}</code>` : ''}${artifact.stage ? `<p>${escape(humanize(artifact.stage))} boundary</p>` : ''}</article>`;
  }).join('');
}

function render() {
  renderStatus(); renderGift(); renderApproval(); renderJourney(); renderEvidence();
  document.querySelectorAll('[data-scenario]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.scenario === state.scenario)));
  document.querySelectorAll('button[data-command]').forEach((button) => {
    button.disabled = Boolean(busy) || button.disabled;
  });
  // Scenario buttons are persistent; reset their disabled state after a request.
  document.querySelectorAll('button[data-command="prepare"]').forEach((button) => { button.disabled = Boolean(busy); });
  document.querySelector('main').setAttribute('aria-busy', String(Boolean(busy)));
}

async function act(command, scenario) {
  if (busy) return;
  const operations = {
    prepare:{path:'/api/prepare', body:{scenario}, label:'Preparing a fresh quote and local chain'},
    approve:{path:'/api/approve', body:{termsHash:state.quote?.termsHash}, label:'Recording approval and confirming the local transaction'},
    execute:{path:'/api/execute', body:{}, label:state.phase === 'completed' ? 'Testing replay rejection on the local contract' : 'Checking authorization and executing the fixture'},
    reconcile:{path:'/api/reconcile', body:{}, label:'Checking for the existing simulated order'},
  };
  const operation = operations[command];
  if (!operation) return;
  if (command === 'prepare' && !['happy','price_change','uncertain'].includes(scenario)) return;
  if (command === 'approve' && (state.phase !== 'quoted' || !state.quote?.termsHash)) return;
  if (command === 'execute' && !(state.phase === 'completed' || (state.phase === 'approved' && confirmed()))) return;
  if (command === 'reconcile' && state.phase !== 'needs_reconciliation') return;
  busy = operation.label; render();
  try { await request(operation.path, operation.body); }
  catch (error) { retainError(error.code || 'request_failed'); }
  finally { busy = ''; render(); }
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-command]');
  if (button && !button.disabled) void act(button.dataset.command, button.dataset.scenario);
});

async function initialize() {
  render();
  try {
    const ok = await request('/api/state');
    if (ok && !state.runId) {
      busy = 'Preparing a fresh quote and local chain'; render();
      await request('/api/prepare', {scenario:'happy'});
    }
  } catch (error) { retainError(error.code || 'request_failed'); }
  finally { busy = ''; render(); }
}

void initialize();
