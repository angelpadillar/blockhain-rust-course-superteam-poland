# Buena AI — final hackathon sprint

Planning date: September 19, 2026. User identifies tomorrow as the last day; confirm the actual submission time. These are proposed work blocks, not an assertion about the event schedule.

## One goal

**Show one gifting request become an authorized, verifiable action — and show the agent stop when the approved terms change.**

Use the existing VPS browser and Solana mandate work. The missing deliverable is their integration. The dependable first version uses a controlled merchant fixture, real local Solana transactions, and explicitly simulated fulfillment. A real merchant browsing segment is optional once that version passes.

## Today: finish the proof

| Work block | Deliverable | Stop condition |
|---|---|---|
| First 30 minutes | Confirm deadline, inspect existing code and VPS health, select one gift scenario | Do not change working browser frameworks |
| Next 90 minutes | One shared quote/mandate encoding, checked against the Rust vector; one fresh test campaign | If integration is larger than expected, narrow to one merchant and one gift immediately |
| Next 90 minutes | Browser observation → local-chain authorization → one simulated fulfillment → verified receipt | No second mutation after an uncertain response |
| Next 60 minutes | Changed-price and replay attempts rejected; receipt records why | Retain failures and manual interventions in the report |
| Next 60 minutes | Three consecutive fresh-state rehearsals; collect timings, calls and known costs | Report the exact fixture and denominator |
| Final 30 minutes | Freeze the working version; record a 90-second backup | No dependency upgrades after this point |

If less time remains, remove optional real-site browsing and visual flourishes. If the integration cannot be completed, present the browser and mandate as separately verified modules with an explicit integration gap. Do not stage a fake end-to-end transaction.

### Demo example

A sales rep proposes a coffee gift for a fictional prospect. The page shows the gift, merchant, recipient commitment, currency and exact test quote. The sender authorizes the permitted action. The browser completes the fixture workflow; the receipt links the browser evidence and local-chain mandate. Next, change the price: the run stops. Repeat the same attempt: no second fulfillment occurs.

Do not reuse the old alcohol product-navigation case. Keep recipient details fictional and label the merchant fixture and simulated fulfillment visibly.

## Tomorrow: make it easy to understand

1. Re-run the frozen demonstration from clean state, including both rejection cases.
2. Polish one review screen: request, approved limits, current state, result and inspectable receipt. Keep technical hashes expandable.
3. Rehearse the talk with the exact demo laptop/network setup. Keep the backup video locally available.
4. Submit before the confirmed deadline with a buffer; preserve the release version and evidence.

## Three-minute presentation

- **0:00–0:25 — Customer problem:** thoughtful outbound gifting requires research, approval and reliable execution; a recommendation alone does not get the task done.
- **0:25–1:35 — Demonstration:** show one request, authorization and verified test result. Label local Solana and simulated merchant fulfillment.
- **1:35–2:05 — Failure behavior:** changed quote and repeated attempt are rejected.
- **2:05–2:35 — Why this architecture:** the browser handles the website; Jev selects bounded actions when needed; Solana records and consumes the sender’s authorization; a verifier checks outcomes.
- **2:35–3:00 — Business next step:** validate gift relevance, reliable delivery and qualified conversations in a 25-gift pilot alongside paid sales-team trials.

## Proof slide: use these scoped numbers

- Controlled browser readiness cohort: **3/9 → 9/9 completed runs**, across immediate and delayed controls. This was a fixture, not general web reliability.
- Live merchant navigation baseline: **3/3**, median **13.589 seconds**. Navigation only; no purchase.
- Jev selection evaluation: **45/45 expected choices**, median **276ms**. Choices, not 45 completed tasks.
- Solana mandate validation: **18 integration tests plus one program-ID unit test** in the recorded local run. Not evidence of production deployment.

Use the new integrated-demo results once measured. Do not pool these unrelated counts.

## Judge questions to prepare for

**What is distinctive if Sendoso and others have MCP?**
The proposed distinction is execution quality and outcomes in a focused gifting workflow. Existing spending controls and MCP interfaces alone are not novel. Customer pilots must validate the distinction.

**Why Solana?**
It provides a signed, inspectable, one-use authorization and escrow state machine in this prototype. It cannot independently establish that an off-chain merchant shipped the right gift.

**Can the agent steal?**
Describe the fields and transitions actually enforced. Do not claim an absolute guarantee: browser observations, fulfillment verification and real-world payment integration still have trust assumptions.

**What happens if checkout times out?**
The state becomes uncertain until reconciled. The system should not blindly repeat the payment or refund it.

**What is live?**
Answer with the exact demo environment: real browser, controlled merchant, real local-chain transaction, simulated fulfillment. If any segment changes to devnet or a live merchant, update the labels and evidence.

## Done checklist

- [ ] One reproducible integrated path with a clean reset
- [ ] Three consecutive happy-path rehearsals, with all attempts recorded
- [ ] Price-change and replay rejection demonstrated
- [ ] Receipt links authorization, action and verification
- [ ] Real, fixture, simulated and manual steps visibly distinguished
- [ ] 90-second backup and rehearsed three-minute presentation
- [ ] Submission complete with time to spare
