# One decision from an actual editor observation

`src/ui-selection.mjs` evaluates the deployed TypeSafe client's choice among observed switches. It neither collects browser state nor performs a browser action. The caller supplies a minimal projection from a fresh, authorized editor snapshot.

Input shape (illustrative only; replace every ref/state with the actual observation):

```json
{
  "version": 1,
  "observationId": "actual-snapshot-token",
  "capturedAt": "2026-09-18T12:00:00.000Z",
  "expectedRef": "e2",
  "candidates": [
    {"ref":"e1","role":"switch","name":"","labelContext":"Voiceover Only","checked":false,"disabled":false},
    {"ref":"e2","role":"switch","name":"","labelContext":"Generate media","checked":true,"disabled":false},
    {"ref":"e3","role":"switch","name":"","labelContext":"Auto Trim","checked":true,"disabled":false}
  ]
}
```

The script rejects unknown fields, non-toggle controls, duplicated refs, missing state, a disabled expected target, and evidence older than 15 minutes. Do not include page URLs, account details, credentials, or complete DOM snapshots. `expectedRef` is used only to score the response; it is not sent to the model.

Run inside the existing Camoufox service, after copying the script and an actual projection there:

```sh
node /tmp/ui-selection.mjs /tmp/switch-projection.json /app/state/typesafe-switch-selection.json --validate-only
node /tmp/ui-selection.mjs /tmp/switch-projection.json /app/state/typesafe-switch-selection.json
```

Validation sends zero requests. The live invocation imports `/app/src/jev.mjs`, reads only `/run/secrets/typesafe_key`, and makes one TypeSafe request. It writes a durable started receipt first and refuses any existing report path. No automatic retries are made. The report retains minimal labels, expected/chosen IDs, confidence, probability map, client latency, and actual token usage.

A successful selection is not proof that Generate media is off. The parent must obtain fresh DOM evidence and perform the separately authorized guarded action, then verify `checked:false`.

## Actual editor observation result

One authorized call on 2026-09-18 selected **c2 → e15, Generate media**, from the three switches in the saved draft snapshot. Confidence was **0.94**, client latency **616.55 ms**, and usage **640 input / 49 output tokens**. No browser observations or actions were performed by this test. This single measurement is selection evidence, not an editing/export latency benchmark.

- [Minimal supplied projection](./reports/live-ui-switches-20260918/projection.json)
- [Actual live result](./reports/live-ui-switches-20260918/report.json)
