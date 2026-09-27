/**
 * Read-only ingesters that turn existing browser evidence into decision
 * records. Sources are never modified; secret material is redacted and the
 * redaction path is recorded on the record.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { guardSecrets, makeDecisionId, pseudonymizeProfile, SCHEMA } from './schema.mjs';
import { imageInfo } from './dedupe.mjs';
import { ingestDecisionJournals } from './journal.mjs';

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function walk(dir, match, depth = 6, out = []) {
  if (!existsSync(dir) || depth < 0) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(path, match, depth - 1, out);
    else if (match(path)) out.push(path);
  }
  return out;
}

function baseRecord(fields, { redactions = [] } = {}) {
  const record = {
    schema: SCHEMA,
    step: 0,
    candidates: [],
    recommendations: { deterministic: null, jev: null, valen: null },
    executed: null,
    recovery: { is_recovery: false, reason: null },
    human_escalation: { kind: 'none', reason: null, raised_at: null, cleared_at: null, post_clear_verification: null },
    outcome: { status: 'unknown', verified: false },
    metrics: { latency_ms: null, cost_usd: null },
    provenance: { source: 'unknown', files: [], source_commit: null },
    security: false,
    ...fields,
  };
  record.decision_id =
    record.decision_id ??
    makeDecisionId({
      trajectory_id: record.trajectory_id,
      step: record.step,
      timestamp: record.timestamp,
      executed_action: record.chosen ?? record.executed?.action ?? null,
      candidate_ids: record.candidates.map((candidate) => candidate.id),
      observation_epoch: record.state?.observation_epoch,
    });
  if (redactions.length) record.redactions = redactions;
  return record;
}

function guard(record) {
  const { value, redactions } = guardSecrets(record, { redact: true });
  return { record: value, redactions };
}

function attachImage(record, sourcePath, hasher, meta = {}) {
  if (!sourcePath || !existsSync(sourcePath)) return record;
  const info = imageInfo({ evidence: { screenshot: { source_path: sourcePath } } }, { hasher });
  record.evidence = {
    ...(record.evidence ?? {}),
    screenshot: { source_path: sourcePath, sha256: info.sha256, dhash: info.dhash, bytes: info.bytes, ...meta },
  };
  return record;
}

function urlClass(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '') || parsed.hostname;
  } catch {
    return String(url).slice(0, 120);
  }
}

/* ------------------------------------------------------------------ *
 * A. Live router observations (browser worktree job directories)
 * ------------------------------------------------------------------ */

export function ingestRouterObservations(browserRepo, { hasher = null } = {}) {
  const records = [];
  if (!browserRepo || !existsSync(browserRepo)) return records;
  const files = walk(browserRepo, (path) => path.endsWith('router-observations.ndjson'), 6);
  for (const file of files) {
    const dir = file.replace(/\/router-observations\.ndjson$/, '');
    const observations = readNdjson(file);
    if (!observations.length) continue;
    const receipts = readNdjson(join(dir, 'receipts.ndjson'));
    const events = readNdjson(join(dir, 'events.ndjson'));
    const job = readJson(join(dir, 'job.json')) ?? {};
    const jobId = job.id ?? job.jobId ?? basename(dir);
    const screenshots = walk(join(dir, 'screenshots'), (path) => /\.(png|jpe?g|webp)$/i.test(path), 2);
    const decisions = observations.filter((event) => event.kind === 'decision');
    const executions = new Map(observations.filter((event) => event.kind === 'execution').map((event) => [event.decisionId, event]));
    const outcomes = new Map(observations.filter((event) => event.kind === 'outcome').map((event) => [event.decisionId, event]));
    const screenshotEvent = events.find((event) => event.event === 'screenshot' && event.path);
    const screenshotPath = screenshotEvent?.path && existsSync(screenshotEvent.path) ? screenshotEvent.path : screenshots[0] ?? null;

    for (const decision of decisions) {
      const execution = executions.get(decision.id);
      const outcome = outcomes.get(decision.id);
      const operation = decision.chosen?.tool ?? decision.chosen?.id ?? null;
      const receipt =
        receipts.find((entry) => entry.action?.operation === operation && String(entry.idempotencyKey ?? '').includes(`s${decision.step}-`)) ??
        receipts.find((entry) => entry.action?.operation === operation) ??
        null;
      const candidateList = (decision.candidates ?? []).map((candidate) => ({
        id: candidate.tool ?? candidate.id,
        description: `Router candidate ${candidate.tool ?? candidate.id}`,
        tool: candidate.tool ?? null,
        risk: candidate.risk ?? null,
      }));
      let labelQuality = 'AMBIGUOUS';
      let verified = false;
      if (outcome?.succeeded === true && receipt?.state === 'verified' && receipt?.postconditionMet === true) {
        labelQuality = 'VERIFIED_SUCCESSFUL_ACTION';
        verified = true;
      } else if (outcome?.succeeded === true) {
        labelQuality = 'OBSERVED_SUCCESSFUL_ACTION';
      } else if (outcome?.succeeded === false) {
        labelQuality = 'FAILED_ACTION';
      }
      const stateClass = decision.stateClass ?? 'unknown';
      const record = baseRecord({
        job_id: jobId,
        profile_id: pseudonymizeProfile(receipt?.scope?.profileRef ?? job.profileRef ?? job.accountRef ?? jobId),
        trajectory_id: jobId,
        step: decision.step ?? 0,
        timestamp: decision.at ?? new Date().toISOString(),
        state: {
          text: `Login phase ${decision.phase ?? 'unknown'}; state class ${stateClass}.`,
          page_class: `router.${stateClass}`,
          state_class: stateClass,
          url_class: urlClass(receipt?.observationUrl),
          observation_epoch: receipt?.observationEpoch ?? null,
          fingerprint_material: [stateClass, decision.phase ?? '', operation ?? ''],
          normalized: {
            phase: decision.phase ?? null,
            stateClass,
            candidateCount: decision.candidateCount ?? candidateList.length,
            routerPolicy: decision.router?.policy ?? null,
            routerAgreed: decision.router?.agreed ?? null,
            scorerSource: decision.scorerSource ?? null,
          },
        },
        candidates: candidateList,
        chosen: operation,
        recommendations: {
          deterministic: decision.scorerSource === 'deterministic' && operation ? { top1: operation, top3: [operation], confidence: null, latency_ms: null } : null,
          jev: decision.scorerSource === 'jev' && operation ? { top1: operation, top3: [operation], confidence: decision.chosen?.confidence ?? null, latency_ms: null } : null,
          valen: null,
        },
        executed: execution
          ? { action: execution.executed?.action ?? operation, result: execution.result ?? null, source: decision.scorerSource ?? null }
          : null,
        recovery: {
          is_recovery: outcome?.reason === 'reobserve',
          reason: outcome?.reason ?? null,
        },
        human_escalation: {
          kind: /human|escalat|captcha|challenge/i.test(operation ?? '') ? 'security_checkpoint' : 'none',
          reason: null,
          raised_at: null,
          cleared_at: null,
          post_clear_verification: null,
        },
        outcome: {
          status: outcome?.succeeded === true ? 'success' : outcome?.succeeded === false ? 'failure' : 'unknown',
          verified,
          evidence: outcome ? `router outcome=${outcome.result ?? 'unknown'}` : null,
        },
        label_quality: labelQuality,
        attempted_action: operation,
        label:
          labelQuality === 'VERIFIED_SUCCESSFUL_ACTION'
            ? { target_action: operation, basis: 'receipt', evidence_refs: [file, ...(receipt?.id ? [`receipt:${receipt.id}`] : [])] }
            : undefined,
        metrics: { latency_ms: null, cost_usd: null },
        provenance: {
          source: 'router-observations',
          files: [file, join(dir, 'receipts.ndjson'), join(dir, 'events.ndjson')].filter(existsSync),
          source_commit: null,
        },
      });
      if (screenshotPath) {
        attachImage(record, screenshotPath, hasher, {
          adjacency: 'approximate',
          note: 'nearest captured frame (browser_ready) for this job; not synchronized to the decision epoch',
        });
      }
      records.push(guard(record).record);
    }
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * B. Trust validation runs (fictional fixture; chained receipts)
 * ------------------------------------------------------------------ */

export function ingestTrustValidationRuns(browserRepo, { hasher = null } = {}) {
  const records = [];
  const root = join(browserRepo, 'agent/trust/integrated/validation-runs');
  if (!existsSync(root)) return records;
  for (const stamp of readdirSync(root)) {
    const stampDir = join(root, stamp);
    for (const runId of readdirSync(stampDir)) {
      const runDir = join(stampDir, runId);
      const receiptPath = join(runDir, 'receipt.json');
      if (!existsSync(receiptPath)) continue;
      const receipt = readJson(receiptPath);
      if (!receipt) continue;
      const chain = (receipt.chain?.transactions ?? []).map((tx) => `${tx.label}:${tx.success ? 'ok' : 'fail'}`);
      for (const file of readdirSync(runDir).filter((name) => name.endsWith('.png'))) {
        const kind = file.split('-')[0];
        if (!['quote', 'approval', 'confirmation'].includes(kind)) continue;
        const sidecar = join(runDir, file.replace(/\.png$/, '.json'));
        if (!existsSync(sidecar)) continue;
        const observation = readJson(sidecar) ?? {};
        const stages = {
          quote: [
            { id: 'approve_exact_quote', description: 'Approve the exact reviewed quote without changing its terms', risk: 'medium' },
            { id: 'reject_quote', description: 'Reject the quote and stop the flow' },
          ],
          approval: [
            { id: 'execute_settlement', description: 'Consume the approved mandate and submit the settlement', risk: 'high' },
            { id: 'reject_quote', description: 'Stop before settlement' },
          ],
          confirmation: [
            { id: 'verify_confirmation', description: 'Verify the order confirmation and record the receipt' },
            { id: 'flag_discrepancy', description: 'Flag a discrepancy against the approved quote' },
          ],
        }[kind];
        const chosen = { quote: 'approve_exact_quote', approval: 'execute_settlement', confirmation: 'verify_confirmation' }[kind];
        const record = baseRecord({
          job_id: `trust-validation-${stamp}`,
          profile_id: pseudonymizeProfile(`trust-fixture-${runId}`),
          trajectory_id: `trust-${runId}`,
          step: { quote: 0, approval: 1, confirmation: 2 }[kind],
          timestamp: new Date(Number(observation.observedAt) || Date.now()).toISOString(),
          state: {
            text: `${kind} boundary for a fictional coffee gift order (merchant ${observation.merchantId ?? 'unknown'}, total ${((observation.totalMinor ?? 0) / 100).toFixed(2)} ${observation.currency ?? ''}).`,
            page_class: `trust.${kind}`,
            state_class: kind,
            url_class: urlClass(observation.pathname),
            normalized: {
              merchantId: observation.merchantId ?? null,
              currency: observation.currency ?? null,
              totalMinor: observation.totalMinor ?? null,
              scenario: receipt.scenario ?? null,
              phase: receipt.phase ?? null,
              authorizationConfirmed: Boolean(receipt.authorization?.confirmed),
              chainReceipts: chain,
            },
            fingerprint_material: [kind, receipt.scenario ?? ''],
          },
          candidates: [...stages, { id: 'inspect_evidence', description: 'Inspect the quote and evidence without changing any terms' }, { id: 'escalate_to_human', description: 'Stop and escalate to a human operator' }],
          chosen,
          recommendations: { deterministic: { top1: chosen, top3: [chosen], confidence: null, latency_ms: null }, jev: null, valen: null },
          executed: { action: chosen, result: receipt.phase === 'completed' ? 'completed' : receipt.phase ?? 'unknown', source: 'curated_policy' },
          outcome: {
            status: receipt.phase === 'completed' ? 'success' : 'unknown',
            verified: receipt.phase === 'completed',
            evidence: `receipt.phase=${receipt.phase}; ${chain.length} chain receipts`,
          },
          label_quality: 'CURATED_REQUIRED_ACTION',
          label: { target_action: chosen, basis: 'curated_policy', evidence_refs: [receiptPath, sidecar] },
          provenance: { source: 'trust-validation-runs', files: [join(runDir, file), sidecar, receiptPath], source_commit: null },
        });
        attachImage(record, join(runDir, file), hasher);
        const value = guard(record).record;
        records.push(value);
      }
    }
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * C. Trust demo captures (accepted and rejected scenarios)
 * ------------------------------------------------------------------ */

export function ingestTrustDemo(browserRepo, { hasher = null } = {}) {
  const records = [];
  const root = join(browserRepo, 'agent/trust/demo/evidence-captures');
  if (!existsSync(root)) return records;
  const validationPath = join(root, 'validation.json');
  const validation = readJson(validationPath) ?? [];
  for (const scenario of ['happy', 'price_increase', 'merchant_mismatch', 'expired']) {
    const manifestPath = join(root, `manifest-${scenario}.json`);
    if (!existsSync(manifestPath)) continue;
    const outcome = validation.find((entry) => entry.scenario === scenario) ?? {};
    const canonical = scenario === 'happy';
    for (const entry of readJson(manifestPath) ?? []) {
      const imagePath = join(root, entry.screenshotPath);
      if (!existsSync(imagePath)) continue;
      const observation = readJson(join(root, entry.observationPath)) ?? {};
      const stage = entry.stage;
      const candidates = {
        quote: [
          { id: 'approve_exact_quote', description: 'Approve the exact reviewed quote without changing its terms', risk: 'medium' },
          { id: 'reject_quote', description: 'Reject the quote because it violates the mandate boundary' },
        ],
        approval: [
          { id: 'execute_settlement', description: 'Consume the approved mandate and submit the settlement', risk: 'high' },
          { id: 'reject_quote', description: 'Reject the approval because the terms changed' },
        ],
        confirmation: [
          { id: 'verify_confirmation', description: 'Verify the order confirmation and record the receipt' },
          { id: 'reject_quote', description: 'Reject the confirmation because it does not match the approval' },
        ],
      }[stage] ?? [];
      const chosen = canonical ? { quote: 'approve_exact_quote', approval: 'execute_settlement', confirmation: 'verify_confirmation' }[stage] : 'reject_quote';
      const record = baseRecord({
        job_id: `trust-demo-${scenario}`,
        profile_id: pseudonymizeProfile('trust-demo-fixture'),
        trajectory_id: `trust-demo-${scenario}`,
        step: { quote: 0, approval: 1, confirmation: 2 }[stage] ?? 0,
        timestamp: new Date(Number(observation.observedAt) || Date.now()).toISOString(),
        state: {
          text: `${canonical ? 'Accepted' : 'Rejected'} trust-demo scenario "${scenario}" at the ${stage} boundary.`,
          page_class: `trust-demo.${stage}`,
          state_class: stage,
          url_class: urlClass(observation.pathname),
          normalized: {
            scenario,
            stage,
            headings: observation.headings ?? [],
            totalMinor: observation.totalMinor ?? null,
            validationStatus: outcome.status ?? null,
            confirmedOrders: outcome.confirmedOrders ?? null,
          },
          fingerprint_material: [stage, scenario, ...(observation.headings ?? []).slice(0, 3)],
        },
        candidates: [...candidates, { id: 'inspect_evidence', description: 'Inspect the quote and evidence without changing any terms' }, { id: 'escalate_to_human', description: 'Stop and escalate to a human operator' }],
        chosen,
        recommendations: { deterministic: { top1: chosen, top3: [chosen], confidence: null, latency_ms: null }, jev: null, valen: null },
        executed: { action: chosen, result: outcome.status ?? 'unknown', source: 'curated_validator_policy' },
        outcome: {
          status: 'success',
          verified: Boolean(outcome.integrityValid && outcome.boundaryComplete),
          evidence: `sealed validation: status=${outcome.status}, confirmedOrders=${outcome.confirmedOrders}, integrityValid=${outcome.integrityValid}`,
        },
        label_quality: 'CURATED_REQUIRED_ACTION',
        label: { target_action: chosen, basis: 'curated_validator_policy', evidence_refs: [manifestPath, validationPath] },
        provenance: { source: 'trust-demo', files: [imagePath, join(root, entry.observationPath), manifestPath, validationPath], source_commit: null },
      });
      attachImage(record, imagePath, hasher);
      const value = guard(record).record;
      records.push(value);
    }
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * D. Main-repo agent/out (altitude treasury, Glovo order)
 * ------------------------------------------------------------------ */

export function ingestMainOut(mainRepo, { hasher = null } = {}) {
  const records = [];
  const out = join(mainRepo, 'agent/out');
  const screenshots = join(out, 'screenshots');
  if (!existsSync(out)) return records;
  const altitude = [
    { png: 'altitude-balance.png', json: 'altitude-balance.json', state: 'Treasury balance and card list view.', candidates: ['create_card', 'freeze_card', 'view_card_transactions'], label: 'AMBIGUOUS' },
    { png: 'altitude-card-freeze.png', json: 'altitude-card-freeze.json', state: 'Card management view opened for a freeze preview (dry run).', candidates: ['confirm_freeze_card', 'cancel', 'view_card_transactions'], label: 'AMBIGUOUS' },
    { png: 'altitude-card-create-form.png', json: 'altitude-card-create.json', state: 'Card creation form before submission.', candidates: ['submit_card_creation', 'cancel'], label: 'AMBIGUOUS' },
    { png: 'altitude-card-create-error.png', json: 'altitude-card-create.json', state: 'Card creation failed: the expected card heading never appeared.', candidates: ['reobserve_or_retry', 'cancel', 'escalate_to_human'], label: 'FAILED_ACTION', target: 'reobserve_or_retry' },
  ];
  for (const item of altitude) {
    const imagePath = join(screenshots, item.png);
    if (!existsSync(imagePath)) continue;
    const jsonPath = join(out, item.json);
    const sidecar = existsSync(jsonPath) ? readJson(jsonPath) ?? {} : {};
    const record = baseRecord({
      job_id: 'altitude-treasury-2026-09-20',
      profile_id: pseudonymizeProfile('altitude-demo'),
      trajectory_id: 'altitude-2026-09-20',
      step: 0,
      timestamp: sidecar.at ?? new Date().toISOString(),
      state: {
        text: item.state,
        page_class: `altitude.${item.png.replace(/\.png$/, '')}`,
        state_class: sidecar.command ?? 'treasury',
        url_class: urlClass(sidecar.observed?.url),
        normalized: { command: sidecar.command ?? null, status: sidecar.status ?? null, ok: sidecar.ok ?? null, error: sidecar.error ?? null },
      },
      candidates: item.candidates.map((id) => ({ id, description: id.replaceAll('_', ' ') })),
      chosen: item.target ?? null,
      recommendations: { deterministic: null, jev: null, valen: null },
      executed: { action: sidecar.command ?? null, result: sidecar.status ?? 'unknown', source: 'observed_execution' },
      outcome: {
        status: sidecar.ok === false ? 'failure' : sidecar.ok === true ? 'success' : 'unknown',
        verified: false,
        evidence: sidecar.error?.slice(0, 200) ?? sidecar.note ?? null,
      },
      label_quality: item.label,
      attempted_action: item.target ?? item.chosen ?? sidecar.command ?? null,
      label: item.label === 'FAILED_ACTION' || item.label === 'AMBIGUOUS' ? undefined : { target_action: item.target ?? item.chosen, basis: 'observed_failure_or_curated' },
      provenance: { source: 'main-out', files: [imagePath, jsonPath].filter(existsSync), source_commit: null },
    });
    attachImage(record, imagePath, hasher);
    const value = guard(record).record;
    records.push(value);
  }

  const observationPath = join(out, 'mcp-browser-observation.json');
  const confirmationPath = join(out, 'human-confirmation.json');
  const paidPath = join(out, 'paid.json');
  const successPath = join(out, 'payment-success.json');
  const deliveryPath = join(out, 'delivery-evidence.json');
  const observation = existsSync(observationPath) ? readJson(observationPath) ?? {} : {};
  const human = existsSync(confirmationPath) ? readJson(confirmationPath) ?? {} : {};
  const paid = existsSync(paidPath) ? readJson(paidPath) ?? {} : {};
  const delivery = existsSync(deliveryPath) ? readJson(deliveryPath) ?? {} : {};
  const glovo = [
    {
      png: 'glovo-final-checkout.jpg',
      id: 'glovo-checkout',
      state: 'Food-delivery checkout summary immediately before payment-method selection.',
      candidates: [
        { id: 'request_human_payment_approval', description: 'Request explicit human approval before any payment', risk: 'low' },
        { id: 'open_payment_method', description: 'Open the payment-method selector' },
        { id: 'edit_order', description: 'Edit the basket or delivery details' },
        { id: 'abandon_order', description: 'Abandon the order' },
        { id: 'escalate_security_checkpoint', description: 'Escalate a security challenge to a human' },
      ],
      chosen: 'request_human_payment_approval',
      label: 'CURATED_REQUIRED_ACTION',
      basis: 'payment_requires_human_approval',
      outcome: { status: human.confirmed_at ? 'success' : 'unknown', verified: Boolean(human.confirmed_at), evidence: `human confirmation at ${human.confirmed_at ?? 'n/a'}` },
      files: [observationPath, confirmationPath].filter(existsSync),
    },
    {
      png: 'glovo-confirmation.jpg',
      id: 'glovo-payment-confirmation',
      state: 'Order confirmation screen after a successful simulated payment.',
      candidates: [
        { id: 'verify_payment_receipt', description: 'Verify the payment receipt against the approved amount' },
        { id: 'continue_to_delivery_tracking', description: 'Continue to delivery tracking' },
        { id: 'escalate_security_checkpoint', description: 'Escalate a security challenge to a human' },
      ],
      chosen: 'verify_payment_receipt',
      label: 'VERIFIED_SUCCESSFUL_ACTION',
      basis: 'receipt',
      outcome: { status: paid.status === 'paid' ? 'success' : 'unknown', verified: paid.status === 'paid', evidence: `paid order ${paid.order_id ?? 'unknown'} amount ${paid.amount_pln ?? 'unknown'}` },
      files: [paidPath, successPath].filter(existsSync),
    },
    {
      png: 'glovo-delivered.jpg',
      id: 'glovo-delivered',
      state: 'Delivered-order evidence screen for the completed simulated order.',
      candidates: [
        { id: 'record_delivery_evidence', description: 'Record the delivery evidence against the order' },
        { id: 'raise_delivery_exception', description: 'Raise a delivery exception' },
        { id: 'escalate_security_checkpoint', description: 'Escalate a security challenge to a human' },
      ],
      chosen: 'record_delivery_evidence',
      label: 'VERIFIED_SUCCESSFUL_ACTION',
      basis: 'receipt',
      outcome: { status: delivery.status ?? (delivery.ok ? 'success' : 'unknown'), verified: Boolean(delivery.human_receipt_confirmed ?? delivery.ok), evidence: `delivery evidence keys: ${Object.keys(delivery).slice(0, 6).join(',')}` },
      files: [deliveryPath].filter(existsSync),
    },
  ];
  for (const item of glovo) {
    const imagePath = join(screenshots, item.png);
    if (!existsSync(imagePath)) continue;
    const record = baseRecord({
      job_id: 'glovo-order-2026-08-30',
      profile_id: pseudonymizeProfile('glovo-demo'),
      trajectory_id: 'glovo-order-2026-08-30',
      step: 0,
      timestamp: observation.captured_at ?? new Date().toISOString(),
      state: {
        text: item.state,
        page_class: `glovo.${item.id}`,
        state_class: item.id,
        url_class: urlClass(observation.source_url),
        normalized: { checkoutStage: observation.checkout_stage ?? null, landedPln: observation.landed_pln ?? null, humanApprovalMaxPln: human.max_pln ?? null },
        fingerprint_material: [item.id, observation.checkout_stage ?? ''],
      },
      candidates: item.candidates,
      chosen: item.chosen,
      recommendations: { deterministic: { top1: item.chosen, top3: [item.chosen], confidence: null, latency_ms: null }, jev: null, valen: null },
      executed: { action: item.chosen, result: item.outcome.status, source: 'curated_policy' },
      outcome: item.outcome,
      human_escalation: item.id === 'glovo-checkout'
        ? { kind: 'payment_approval', reason: 'payment requires explicit human confirmation', raised_at: human.confirmed_at ?? null, cleared_at: human.confirmed_at ?? null, post_clear_verification: { status: paid.status === 'paid' ? 'verified' : 'unknown' } }
        : { kind: 'none', reason: null, raised_at: null, cleared_at: null, post_clear_verification: null },
      label_quality: item.label,
      label: { target_action: item.chosen, basis: item.basis, evidence_refs: item.files },
      provenance: { source: 'main-out', files: [imagePath, ...item.files], source_commit: null },
    });
    attachImage(record, imagePath, hasher);
    const value = guard(record).record;
    records.push(value);
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * E. Jev benchmark event streams (text-only browser decisions)
 * ------------------------------------------------------------------ */

export function ingestJevBench(mainRepo, { hasher = null } = {}) {
  const records = [];
  const root = join(mainRepo, 'agent/jev/bench/results');
  if (!existsSync(root)) return records;
  for (const runDir of readdirSync(root)) {
    const dir = join(root, runDir);
    if (!statSync(dir).isDirectory()) continue;
    const eventsPath = join(dir, '1.events.jsonl');
    if (!existsSync(eventsPath)) continue;
    const runConfig = readJson(join(dir, 'run.json')) ?? {};
    const runId = runDir;
    const events = readNdjson(eventsPath).map((row) => row.event).filter(Boolean);
    const verdict = events.find((event) => event.type === 'independent_verdict');
    let current = null;
    let runGoal = null;
    const flush = () => {
      if (!current) return;
      current.planned = current.planned.filter(Boolean);
      const action = current.answer?.action;
      const candidates = Object.keys(action?.probabilities ?? {});
      if (!candidates.length) {
        current = null;
        return;
      }
      const choice = action?.choice ?? null;
      const baseOperation = choice ? String(choice).split('@')[0] : null;
      const completions = events.filter(
        (event) => event.type === 'step_completed' && event.step === (current.step ?? 0) && (event.operation === choice || event.operation === baseOperation),
      );
      const outcomes = completions.map((event) => String(event.outcome ?? ''));
      const POSITIVE = /^(filled|clicked|selected|uploaded|plan_executed|waited)$/i;
      const NEGATIVE = /(no_change|unconfirmed|partial|fail|error|timeout|blocked)/i;
      const positive = outcomes.length > 0 && outcomes.every((outcome) => POSITIVE.test(outcome));
      const negative = outcomes.some((outcome) => NEGATIVE.test(outcome));
      const blocked = String(choice ?? '') === 'blocked' || String(choice ?? '') === 'wait';
      let label = 'AMBIGUOUS';
      if (verdict?.status === 'FAIL') {
        // In a failed trajectory only a negative step outcome is attributable to
        // this action; a positive step whose task failed later is unverifiable.
        label = negative ? 'FAILED_ACTION' : blocked && outcomes.length === 0 ? 'FAILED_ACTION' : 'AMBIGUOUS';
      } else if (positive) {
        label = verdict?.status === 'PASS' ? 'VERIFIED_SUCCESSFUL_ACTION' : 'OBSERVED_SUCCESSFUL_ACTION';
      } else if (outcomes.length > 0) {
        // The run verdict (when PASS) verifies the trajectory, not this step.
        label = verdict?.status === 'PASS' ? 'OBSERVED_SUCCESSFUL_ACTION' : negative ? 'FAILED_ACTION' : 'AMBIGUOUS';
      } else if (blocked) {
        label = verdict?.status === 'PASS' ? 'OBSERVED_SUCCESSFUL_ACTION' : 'FAILED_ACTION';
      }
      const isJevDriver = runConfig.config?.driver === 'jev' || runConfig.manifest?.model;
      const probabilities = action.probabilities ?? {};
      const confidence = typeof action.confidence === 'number' ? action.confidence : null;
      const state = {
        text: `Browser benchmark step for goal: ${current.goal ?? runConfig.config?.only ?? runId}.`,
        page_class: `jev-bench.${runConfig.config?.suite ?? 'unknown'}`,
        state_class: runConfig.config?.only ?? 'fixture',
        url_class: null,
        normalized: { goal: current.goal ?? null, step: current.step ?? null, chosenOperation: action.choice ?? null, outcomes, verdict: verdict?.status ?? null },
        fingerprint_material: [runDir, String(current.step ?? ''), action.choice ?? ''],
      };
      const record = baseRecord({
        job_id: 'jev-bench',
        profile_id: pseudonymizeProfile('jev-bench-fixture'),
        trajectory_id: `jev-bench-${runDir}`,
        step: current.step ?? 0,
        timestamp: runConfig.manifest?.timestamp ?? new Date().toISOString(),
        state,
        candidates: candidates.map((id) => ({ id, description: `Benchmark action ${id}` })),
        chosen: action.choice,
        recommendations: {
          deterministic: isJevDriver ? null : { top1: action.choice, top3: [action.choice], confidence, latency_ms: null },
          jev: isJevDriver ? { top1: action.choice, top3: [action.choice], confidence, latency_ms: null } : null,
          valen: null,
        },
        executed: { action: action.choice, result: outcomes.join(',') || 'planned', source: isJevDriver ? 'jev' : 'scripted' },
        outcome: {
          status: label === 'VERIFIED_SUCCESSFUL_ACTION' || label === 'OBSERVED_SUCCESSFUL_ACTION' ? 'success' : label === 'FAILED_ACTION' ? 'failure' : 'unknown',
          verified: label === 'VERIFIED_SUCCESSFUL_ACTION',
          evidence: `step outcomes=[${outcomes.join(',')}] verdict=${verdict?.status ?? 'none'}`,
        },
        label_quality: label,
        attempted_action: action.choice,
        label: label === 'VERIFIED_SUCCESSFUL_ACTION' ? { target_action: action.choice, basis: 'independent_verdict', evidence_refs: [eventsPath] } : undefined,
        provenance: { source: 'jev-bench', files: [eventsPath], source_commit: runConfig.manifest?.git_sha ?? null },
      });
      records.push(guard(record).record);
      current = null;
    };
    for (const event of events) {
      if (event.type === 'loop_started') {
        flush();
        runGoal = event.goal ?? runGoal;
        current = { goal: runGoal, planned: [] };
      } else if (event.type === 'decision') {
        if (current?.answer) flush();
        current = { goal: runGoal, planned: [] };
        current.answer = event.answer;
        current.step = current.step ?? 0;
      } else if (event.type === 'action_planned' && current) {
        current.planned.push({ step: event.step, operation: event.operation, ref: event.ref ?? null });
        current.step = event.step;
      }
    }
    flush();
  }
  return records;
}

/* ------------------------------------------------------------------ *
 * F. Captions-editor artifacts (visual state only; actions AMBIGUOUS)
 * ------------------------------------------------------------------ */

export function ingestCaptions(browserRepo, { hasher = null } = {}) {
  const records = [];
  const root = join(browserRepo, 'agent/captions-editor/artifacts');
  if (!existsSync(root)) return records;
  const spec = [
    { png: 'captions-home.png', sidecar: 'captions-home-snapshot.json', visual: 'NORMAL_PAGE' },
    { png: 'authenticated-home.png', sidecar: 'authenticated-home-snapshot.json', visual: 'AUTHENTICATED' },
    { png: 'navigation-ready.png', sidecar: 'navigation-ready.json', visual: 'AUTHENTICATED' },
    { png: 'upload-failure.png', sidecar: 'upload-failure-network.json', visual: 'NORMAL_PAGE' },
  ];
  for (const item of spec) {
    const imagePath = join(root, item.png);
    const sidecarPath = join(root, item.sidecar);
    if (!existsSync(imagePath) || !existsSync(sidecarPath)) continue;
    const sidecar = readJson(sidecarPath) ?? {};
    const elements = (sidecar.elements ?? []).slice(0, 10).map((el) => `${el.role}:${el.name}`.slice(0, 90));
    const record = baseRecord({
      job_id: 'captions-editor-2026-09-18',
      profile_id: pseudonymizeProfile('captions-signed-in'),
      trajectory_id: 'captions-editor-2026-09-18',
      step: 0,
      timestamp: new Date().toISOString(),
      state: {
        text: `Signed-state artifact for the Captions editor (${item.png}).`,
        page_class: `captions.${item.png.replace(/\.png$/, '')}`,
        state_class: item.visual,
        url_class: urlClass(sidecar.provenance?.url ?? sidecar.url),
        normalized: { elements, visual_state: item.visual },
        fingerprint_material: elements.slice(0, 4),
      },
      candidates: [
        { id: 'click_element', description: 'Click a visible control matched to the task' },
        { id: 'type_text', description: 'Type into a focused input' },
        { id: 'navigate', description: 'Navigate to a URL or route' },
        { id: 'reobserve', description: 'Re-observe the page before acting' },
        { id: 'escalate_to_human', description: 'Stop and escalate to a human operator' },
      ],
      chosen: null,
      outcome: { status: 'unknown', verified: false, evidence: 'state snapshot; no action receipt stored' },
      label_quality: 'AMBIGUOUS',
      label: undefined,
      provenance: { source: 'captions-artifacts', files: [imagePath, sidecarPath], source_commit: null },
    });
    attachImage(record, imagePath, hasher);
    records.push(guard(record).record);
  }
  return records;
}

export function collectAll({ main, browser }, options = {}) {
  const hasher = options.hasher ?? null;
  const collected = [
    ...ingestRouterObservations(browser, { hasher }),
    ...ingestDecisionJournals(browser),
    ...ingestTrustValidationRuns(browser, { hasher }),
    ...ingestTrustDemo(browser, { hasher }),
    ...ingestMainOut(main, { hasher }),
    ...ingestJevBench(main, { hasher }),
    ...ingestCaptions(browser, { hasher }),
  ];
  return collected;
}
