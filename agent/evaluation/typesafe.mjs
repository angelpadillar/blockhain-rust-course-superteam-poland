const endpoint = 'https://api.typesafe.ai/v1/systemone';

/** Small dependency-free client. Credentials stay in memory and go only to TypeSafe. */
export async function evaluate({ state, questions, apiKey = process.env.TYPESAFE_API_KEY,
  model = 'jev-latest', fetchImpl = fetch, timeoutMs = 30_000 }) {
  if (!apiKey) throw new Error('Set TYPESAFE_API_KEY before calling TypeSafe.');
  const started = performance.now();
  const response = await fetchImpl(endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions }),
  });
  // Do not include headers or server response bodies in errors.
  if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}.`);
  const data = await response.json();
  if (!data.answers || typeof data.answers !== 'object') {
    throw new Error('TypeSafe returned no answers.');
  }
  return { latencyMs: Math.round(performance.now() - started), ...data };
}
