const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export class JevError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.body = body;
  }
}

export function createStats() {
  return { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencies: [] };
}

export class Jev {
  constructor({
    apiKey = process.env.TYPESAFE_API_KEY,
    model = process.env.JEV_MODEL || "jev-latest",
    timeoutMs = 20000,
    retries = 2,
    stats = createStats(),
  } = {}) {
    if (!apiKey) throw new JevError("Missing TypeSafe API key (set TYPESAFE_API_KEY)");
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.stats = stats;
  }

  async ask(state, questions, { retries } = {}) {
    const maxRetries = retries ?? this.retries;
    const body = JSON.stringify({ state, model: this.model, questions });
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const t0 = performance.now();
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (res.status === 429 || res.status >= 500) {
          const text = await res.text().catch(() => "");
          lastError = new JevError(`TypeSafe ${res.status}`, { status: res.status, body: text });
          if (attempt < maxRetries) {
            await sleep(res.status === 429 ? 400 + 200 * attempt : 60 * 2 ** attempt);
            continue;
          }
          throw lastError;
        }

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new JevError(`TypeSafe ${res.status}: ${text.slice(0, 300)}`, {
            status: res.status,
            body: text,
          });
        }

        const json = await res.json();
        const latencyMs = performance.now() - t0;
        this.stats.calls++;
        this.stats.latencies.push(latencyMs);
        this.stats.inputTokens += json.usage?.input_tokens ?? 0;
        this.stats.outputTokens += json.usage?.output_tokens ?? 0;
        return { ...json, latencyMs };
      } catch (err) {
        lastError = err;
        this.stats.errors++;
        if (err instanceof JevError && err.status && err.status < 500 && err.status !== 429) throw err;
        if (attempt >= maxRetries) throw err;
        await sleep(80 * 2 ** attempt);
      }
    }
    throw lastError;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
