# No-purchase browser evaluation

This additive evaluation adapter accepts the Codex Browser skill's supported `tab` object. It separates browser observations, a choice of observed actions, execution, timing and independent scoring. It supports Typesafe Jev or supervised Codex decisions. It does not launch another browser, run the legacy fulfillment adapter, load `.env`, or import payment/chain/OTP modules.

The accompanying `REPORT.md` and `summary.json` preserve the measured Glovo pilot and its failed development attempts. Raw account-derived traces remain in the original experiment's gitignored `shopping-private/` directory, not in this source folder.

## Run a new Jev evaluation

From the project's `agent/` directory, Node.js 22+ is sufficient. Set the Typesafe key in the environment without committing it. In macOS zsh:

```sh
read -rs 'TYPESAFE_API_KEY?Typesafe API key: '
export TYPESAFE_API_KEY
printf '\n'
TYPESAFE_BENCHMARK_DIR=out/browser-evaluation/new-run npm run evaluation:worker
```

Use a fresh directory each time. The worker makes only Typesafe API requests. It stops at 80 calls, after 25 minutes, or when `<directory>/queue/STOP` exists. It never controls the browser. Do not start legacy `order:prepare`, payment commands or Solana transactions for this evaluation.

After initializing the Browser skill and reading its required browser documentation, prepare the existing authorized Glovo session and verify the configured destination and empty cart through visible UI. Keep the site and starting conditions the same for both systems. Then, in the Browser skill's supported JavaScript session:

```js
const fsEval = await import('node:fs/promises');
const baseEval = '/Users/buena/Code/blockchain-rust-superteam-poland/agent';
const evalModule = await import('file://' + baseEval + '/evaluation/shopping-benchmark.mjs');
const evalConfig = JSON.parse(await fsEval.readFile(baseEval + '/config.local.json', 'utf8'));
const evalDirectory = baseEval + '/out/browser-evaluation/new-run';
// tab is an observed, connected Browser-skill tab. Set up the cart before timing.
const evalRun = evalModule.createShoppingRun('jev', 'jev-1');
const batch = await evalModule.advanceShopping({
  tab, config: evalConfig, run: evalRun, directory: evalDirectory, steps: 8,
});
// Inspect batch. Continue in bounded calls only while evalRun.stopped is null.
```

The adapter is currently scoped to Glovo's Polish-language Kraków shopping routes. It offers configured product queries and observed UI controls. It has 40-step/20-minute run bounds, rejects stale controls and payment actions, and treats checkout as read-only. Login, address setup, uploads, arbitrary merchant onboarding and checkout form editing are not part of this adapter.

Completion is gated on a rendered checkout summary; a model `done` claim alone is not a passing score. Save a redacted final observation and verify independently:

```js
const finalObservation = await evalModule.observeShopping(tab);
evalRun.finalSnapshot = evalModule.redactor(evalConfig)(finalObservation.snapshot);
const evidenceModule = await import('file://' + baseEval + '/evaluation/shopping-evidence.mjs');
const evidence = evidenceModule.verifyShoppingEvidence(evalRun, evalConfig.items, evalConfig.max_pln);
evalRun.verdict = evidence.passed ? 'passed_before_purchase' : 'failed';
evalRun.independentVerification = evidence;
await fsEval.writeFile(evalDirectory + '/jev-1.json', JSON.stringify(evalRun, null, 2));
const metrics = evalModule.summarizeShopping(evalRun);
// Remove only products added by the test through fresh, observed UI controls.
await fsEval.writeFile(evalDirectory + '/queue/STOP', 'finished');
```

The evidence checker currently understands the Polish cart and order-summary text seen in this pilot. A changed locale or site markup may require updating the adapter and repeating the evaluation.

## Use Codex or another decision provider

Use `prepareShoppingStep(tab, config, run)` to obtain the same observation, candidate actions and request. Let the comparison provider select one offered ID, then pass its response to `finishShoppingStep`:

```js
const referenceRun = evalModule.createShoppingRun('codex', 'codex-reference');
const pending = await evalModule.prepareShoppingStep(tab, evalConfig, referenceRun);
// Present pending actions/page to the decision maker. Do not hardcode replay choices.
const response = { answers: { next_action: { type: 'choice', choice: selectedId } } };
await evalModule.finishShoppingStep(tab, evalConfig, referenceRun, pending, response, evalDirectory);
```

The Jev API key remains in the worker environment, outside the browser. No OpenAI API key is configured by this integration. To measure a standalone LLM fairly, implement its decision request against the same observations and actions and record actual API latency and usage. Codex's supervised desktop timing is a workflow reference, not that standalone API benchmark.

Dollar estimates currently apply only to Jev and use the published input rate of $0.042 per million tokens, with free output. Infrastructure, development, Codex supervision, retries and authentication cost must be budgeted separately. Keep trace directories private.

Run the evaluation-specific checks with `npm run evaluation:test` from `agent/`.
