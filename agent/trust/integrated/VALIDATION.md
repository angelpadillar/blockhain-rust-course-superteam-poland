# Integrated gifting validation — 19 September 2026

The browser → local Solana authorization → simulated merchant → verified result path completed **three consecutive fresh-state rehearsals**. Each used a new campaign and ephemeral keys, executed the compiled program, submitted exactly one fixture order, reached `Purchased` / `Consumed`, and retained valid screenshot/observation evidence at quote, approval and confirmation.

## Completed checks

- **41 JavaScript tests passed:** 24 existing trust/evidence/UI-server tests, 7 independent encoding tests and 10 integrated tests using an actual browser and local SBF execution.
- **18 existing Solana integration tests and 1 program-ID unit test passed** against the unchanged reviewed SBF.
- **3 bridge tests passed:** parsing, signed authorization/replay/atomic rollback, and expiry. The JSONL smoke and independent JavaScript/Rust comparison also passed.
- The interface was exercised in the in-app browser, with visible exact-price approval, confirmed local authorization and verified completion. Source and runtime screenshots were inspected.

The automated evidence report is `validation-runs/2026-09-19T08-41-40-013Z/validation.json`, with 12 recorded stage/outcome entries. Its adjacent run directories hold transaction logs, account state, receipts and image/observation files. Fresh reruns write new timestamped reports; retain the original record.

| Case | Verified result |
| --- | --- |
| Three fresh happy paths | All complete, one merchant dispatch each, canonical 602-byte encoding agrees, all three evidence boundaries present. |
| Approve PLN 129, observe PLN 149 | Executor blocks before attempt consumption; zero merchant dispatches; mandate remains Active. |
| Replay after completion | Fresh signed transaction rejected by program; original order and success remain; no second dispatch. |
| Concurrent execution requests | One succeeds and one is rejected; exactly one fixture order. |
| UI approval flag without mandate | Blocked using actual decoded chain state; no merchant action. |
| Lost merchant response | Pauses after one accepted order; replacement run blocked; reconciliation completes that existing order without another dispatch. |
| Missing approval screenshot | Confirmed mandate alone is insufficient; execution stops because required evidence is incomplete. |
| Screenshot failure after chain confirmation | Reconciliation recognizes matching `Purchased` receipt and finishes evidence without another chain write or merchant order. |
| Lost chain-attempt response | Pending identity remains durable; no browser dispatch; reconciliation sees Consumed and no matching order, so pauses for operator review. |
| Direct merchant request before gate | Fixture rejects a missing one-use permit. |
| Contradictory confirmation | Independent verifier rejects wrong item, variant, quantity, merchant, recipient, currency, amount, order, attempt, status or missing ledger entry. |

## Evidence and limits

`BUILD.json` records local binary hashes. The SBF is unchanged: `5f04b46558cf0427dda612e53f6bec921bb67fc7e08b10f4a868e08113e12e00`. The frozen v4 source hashes remain unchanged in both local project copies. No contract source changes were needed; Rust changes add a host-side example and development dependencies.

The local chain is LiteSVM, not a public validator or deployed cluster. Signers and oracle are ephemeral demo keys. The recipient, recommendation evidence and merchant are fictional. No real purchase, delivery, model inference or wallet authentication occurs. The code saves total interactive elapsed time, but it includes user waiting and is not a browser-model speed comparison. Model calls/cost are zero for this deterministic fixture; infrastructure cost is unmeasured, so no complete cost-per-success claim is made.

No mainnet/devnet transaction, VPS deployment, migration, production key management or live payment connection was performed. The local child process is not a durable chain service; unresolved outcomes cannot be restored merely by restarting it. Chain hashes bind commitments, while the executor and trusted local oracle establish fixture facts. Production source authenticity and end-to-end wallet authentication remain separate work.
