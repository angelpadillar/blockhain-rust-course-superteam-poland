This is an experimental evaluation of browser-use/jev-ultrafast, with original policy and a separate prompt candidate. Read `REPORT.md` before interpreting results. The replacement TypeSafe key works. TYPE_TEXT still needs a configured small text model for the stock upstream method.

The upstream checkout is `../../research/jev-ultrafast`, pinned to `452c1ad2dd628008f1d5608f28158d76e49e6cc0`. Its source was not edited. `requirements.txt` is exported from its lockfile. To build the server harness, first build the upstream wheel and copy it here as `jev_ultrafast-0.1.0-py3-none-any.whl`. Copy the task from `../../hackathon/jev/cases/foczka-navigation.json`. The benchmark Dockerfile installs those pinned dependencies and the wheel; it contains no credentials or browser profile.

Local checks, from the experiment root:

```sh
node benchmarks/jev-ultrafast/reader-benchmark.mjs
research/jev-ultrafast/.venv/bin/pytest -q benchmarks/jev-ultrafast/test_metrics.py
research/jev-ultrafast/.venv/bin/python benchmarks/jev-ultrafast/prompt_benchmark.py --repeats=2
```

The last command makes paid API calls and requests the key with hidden input. It sends synthetic states only and saves each response. Provider failures stop the experiment; do not treat rejected-request latency as model inference time.

Server architecture:

1. Build the existing `/opt/jev-hackathon` Docker image as `jev-hackathon-onboarding`, and this folder as `jev-ultrafast-benchmark`.
2. Run `controller.mjs` inside the existing Node/Playwright image with the private configuration and persistent data volume. Use the existing seccomp profile, non-root user, exclusive profile lock, memory/CPU limits and **no published ports**. The controller listens on private ports 9229 and 9230.
3. Run the benchmark image with `--network container:jev-ultrafast-browser`, a writable private `/results` mount and `--variant stock` or `--variant candidate-v2`.
4. Supply one credentials JSON line on hidden stdin: `typesafe`, and optionally `TEXT_MODEL_API_KEY`, `TEXT_MODEL_BASE_URL`, `TEXT_MODEL`, `TEXT_MODEL_REASONING`. Do not put keys in Docker arguments, source files or shell history. Start the daemon before placing credentials in the model process environment.
5. Stop the browser container gracefully between independent runs. The controller releases the profile lock. Keep every result, including errors; do not automatically retry an uncertain browser mutation.

The live evaluation task is navigation-only and fixed to the authorized Glovo case. Its controller action gate uses the existing adapter's observed navigation controls. It does not support arbitrary shopping tasks or checkout. Changing that scope requires an explicit task contract and corresponding execution policy, not just a different prompt.

OpenRouter helpers can supply cost in `usage.cost`. If a helper/provider omits billable usage, the benchmark marks total cost unknown and stops further model work; do not enter zero. Add verified model pricing if choosing a provider that reports tokens without cost.

`results/prompt-development-20260917T084544Z.json` is the retained first evaluator's infrastructure-failure artifact. Its quality/latency/cost aggregates are invalid. The later diagnostic captures HTTP 402, and the evaluator has been corrected to stop on infrastructure errors. See the report for the distinction.

This folder is also saved in the hackathon repository at `agent/jev/benchmarks/jev-ultrafast`. For the reader test there, point `JEV_ULTRAFAST_DIR` at the pinned source checkout; `JEV_ADAPTER_DIR` defaults to the surrounding `agent/jev` directory. The Docker runner imports the adapter from `/app` and is independent of these local paths.
