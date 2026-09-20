export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarize(attempts, threshold = 0.8) {
  const live = attempts.filter(a => a.mode === 'live');
  const valid = live.filter(a => a.status === 'ok');
  const accepted = valid.filter(a => a.confidence >= threshold && a.choice !== 'none');
  const latency = live.map(a => a.latencyMs).filter(Number.isFinite);
  const countCorrect = list => list.filter(a => a.choice === a.expected).length;
  const rate = (n, d) => d ? n / d : null;
  return {
    liveRequests: live.length,
    validResponses: valid.length,
    failures: live.filter(a => a.status !== 'ok').map(a => ({ caseId: a.caseId, repetition: a.repetition, code: a.failure })),
    rawAccuracy: rate(countCorrect(valid), valid.length),
    endToEndAccuracy: rate(countCorrect(valid), live.length),
    threshold,
    acceptedCount: accepted.length,
    acceptedAccuracy: rate(countCorrect(accepted), accepted.length),
    coverage: rate(accepted.length, live.length),
    lowConfidenceCount: valid.filter(a => a.confidence < threshold).length,
    explicitNoneCount: valid.filter(a => a.choice === 'none').length,
    thresholdedAccuracy: rate(valid.filter(a => (a.confidence >= threshold ? a.choice : 'none') === a.expected).length, live.length),
    latencyMs: { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95), samples: latency.length },
    confidence: valid.length ? { p50: percentile(valid.map(a => a.confidence), 0.5), p95: percentile(valid.map(a => a.confidence), 0.95) } : null,
    usage: live.length ? {
      input_tokens: valid.reduce((n, a) => n + a.usage.input_tokens, 0),
      output_tokens: valid.reduce((n, a) => n + a.usage.output_tokens, 0),
      unknownResponses: live.length - valid.length,
    } : null,
    errors: valid.filter(a => a.choice !== a.expected).map(a => ({ caseId: a.caseId, repetition: a.repetition, expected: a.expected, actual: a.choice, confidence: a.confidence })),
    note: 'Latency includes transport and response parsing, no retries. Usage is known only for validated responses. Confidence is not correctness or authorization. No live calls means null model metrics.',
  };
}
