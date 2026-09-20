# TypeSafe contract review — 2026-09-18

Reviewed `captions-editor-agent/src/jev.mjs` against the current official [API reference](https://docs.typesafe.ai/api), [Choice primitive](https://docs.typesafe.ai/primitives/choice), [function-calling cookbook](https://docs.typesafe.ai/cookbooks/function_calling), and [docs index](https://docs.typesafe.ai/llms.txt).

## Existing code matches

- Endpoint, Bearer authorization, `model: "jev-latest"`, structured `state`, `questions.action.type: "choice"`, and string-valued criteria are supported.
- Its closed observed candidate list plus `none` follows the recommended explicit no-match pattern.
- It correctly rejects unknown choices and validates confidence and token usage.
- Semantic selection remains separate from policy and browser execution.

## Recommended fixes for the adapter owner

1. Validate and retain the returned **probabilities** map: every criteria key, finite probabilities from zero to one, and total approximately one. The official Choice response includes this field. Confidence and chosen-option probability are different measurements.
2. Reject **duplicate IDs and reserved `none` IDs** before `Object.fromEntries`; otherwise choices can silently overwrite each other.
3. Handle an omitted optional abort signal before `AbortSignal.any`; including `undefined` throws before the request.
4. Measure request bytes as UTF-8 bytes, not JavaScript string length, when enforcing a byte-size guard.
5. Keep **raw choice, confidence, and thresholded choice** separately. The existing 0.8 threshold is a policy heuristic, not a documented guarantee; evaluate accuracy and abstention rather than presenting confidence as correctness.
6. Record safe failure codes and model/usage/latency. A non-200 or malformed response must never become a guessed control. Retrying should be explicitly bounded and visible in request/latency accounting.

Only the new evaluation directory was changed for this task; the production adapter is owned by the coordinating agent.

## Important boundaries

- Question IDs are not visible to the model. Each question's instructions must fully explain its decision.
- Choice supports a maximum of 255 options. This harness limits candidates to 254 plus `none`.
- The API reference specifies string/null descriptions while the conceptual Choice page also mentions object/array descriptions. String criteria avoid that discrepancy.
- Questions in one request are independent; one cannot condition its answer on another's hidden result. Only batch independent judgments on shared evidence.
- The function-calling cookbook uses a sample model version, but the API reference recommends `jev-latest`.
- The model cannot choose an asset or editor control absent from its input. A landing-page benchmark does not establish authenticated editor execution.
- Freshness, permitted actions, file integrity, allowed accounts, and actual execution remain application responsibilities. Treat labels as untrusted observations.
