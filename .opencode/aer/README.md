# AER tools (installed by aer-install)

This directory is managed by `aer-install` and belongs to the **frozen AER v1**
plugin at `../plugins/jev-efficiency-observer` (source commit
`c35667da0fca37456f42bea96a851c50ba31ef5e`, build `jev-aer-v1-20260925`, safe
preset). It contains no runtime code and does not affect execution.

## Passive telemetry report

```sh
node .opencode/aer/report.mjs --last 10
node .opencode/aer/report.mjs --last 50 --provider-usage
node .opencode/aer/report.mjs --json
```

Reads `.jev-efficiency/telemetry.jsonl` written by ordinary sessions. With
`--provider-usage` it additionally calls `opencode session export <id>` for token
totals and session cost; no other provider calls are made.

## Fail-open fixture

```sh
bun test .opencode/aer/tests/fail-open.test.mjs
```

Proves against the installed artifact that classifier/reducer/evidence/projection
errors preserve the original tool result and the session keeps working, that the
soft shortlist never removes tools, and that the projection fail-open returns the
canonical messages unchanged.

## Provenance

`.opencode/aer-install.json` records the pinned source commit, runtime build id,
payload hash and verification timestamp. Re-verify any time:

```sh
node <aer-install>/aer-install.mjs verify <project-path>
```

To disable without deleting anything: set `enabled: false` in
`.opencode/jev-efficiency.json`, or run `aer-install.mjs disable <project>`.
