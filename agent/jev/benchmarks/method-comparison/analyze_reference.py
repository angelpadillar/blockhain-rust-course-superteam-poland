#!/usr/bin/env python3
"""Reconstruct public timing/rollback evidence from a saved navigation journal.

Offline and stdlib-only. Output uses an explicit allowlist; no page text, URLs,
control labels, task names, account values, request bodies or headers are copied.
"""

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
import unicodedata
from collections import Counter
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


HERE = Path(__file__).resolve().parent
DEFAULT_JOURNAL = (
    HERE.parents[1]
    / "shopping-private/2026-09-17-ultrafast/results/reference-journal-20260917.json"
)
DEFAULT_OUTPUT = HERE / "results/reference-analysis.json"
# The reference implementation was compared with this journal source hash.
# Its observeReady() uses a 700 ms stability floor and an 8,000 ms cap.
REFERENCE_SOURCE_SHA256 = "678b6511ceca19252e90f4de609ed1cbae9f828bbe57a15566635f39012a6df6"
METRIC_KEYS = (
    "totalMs", "startPageMs", "modelMs", "browserMs", "journalMs",
    "actions", "modelActions", "policyActions", "modelCalls", "inputTokens",
    "outputTokens", "estimatedModelUsd", "authorizedAgeConfirmations",
    "ageConfirmationMs",
)


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("Expected a numeric journal field")
    if not math.isfinite(value) or value < 0:
        raise ValueError("Invalid numeric journal field")
    return value


def rounded(value):
    return round(value, 3)


def normalize(value):
    return " ".join(unicodedata.normalize("NFKC", str(value)).split()).lower()


def action_kind(entry):
    action = entry.get("action", "")
    if action.startswith("Open product:"):
        return "product"
    if action.startswith("Open category:"):
        return "category"
    if entry.get("kind") == "authorized_site_confirmation":
        return "authorized_confirmation"
    if action.startswith("Submit search for "):
        return "search_submit"
    if action.startswith("Search for "):
        return "search_fill"
    if action.startswith("Open link:"):
        return "link"
    return "other"


def summarize(raw):
    journal = json.loads(raw)
    result = journal["result"]
    events = journal["events"]
    task = result["contract"]
    target = urlsplit(task["targetUrl"])
    target_query = parse_qs(target.query)
    for key in ("productId", "externalProductId"):
        if not target_query.get(key):
            raise ValueError("Journal has no product verification target")

    def evidence(url, page=None):
        current = urlsplit(url)
        query = parse_qs(current.query)
        same_store = (current.scheme, current.netloc, current.path) == (
            target.scheme, target.netloc, target.path
        )
        ids_match = all(query.get(k) == target_query[k]
                        for k in ("productId", "externalProductId"))
        titles = (page or {}).get("dialogTitles", [])
        return {
            "sameStore": same_store,
            "bothTargetProductIds": ids_match,
            "visibleExactProductTitle": any(
                normalize(t) == normalize(task["product"]) for t in titles
            ),
            "targetCategory": bool(target_query.get("content"))
            and query.get("content") == target_query["content"],
        }

    measured = {k: number(result["metrics"][k]) for k in METRIC_KEYS}
    rows = []
    planned = executed = None
    first_category = None
    for event in events:
        event_type = event["type"]
        if event_type == "action_planned":
            planned, executed = event, None
        elif event_type == "action_executed":
            if planned is None or event["step"] != planned["step"]:
                raise ValueError("Unpaired action execution")
            executed = event
        elif event_type == "step_completed":
            if planned is None or executed is None:
                raise ValueError("Unpaired completed step")
            entry = event["entry"]
            completed_ms = number(event["elapsedMs"])
            executed_ms = number(executed["elapsedMs"])
            action_and_wait_ms = number(entry["actionAndWaitMs"])
            # actionAndWaitMs is captured immediately before step_completed.
            # Differences include small bookkeeping overhead; they are estimates.
            action_start_ms = completed_ms - action_and_wait_ms
            action_ms = executed_ms - action_start_ms
            intervening_journal_ms = (
                number(event["metrics"]["journalMs"])
                - number(executed["metrics"]["journalMs"])
            )
            ready_ms = completed_ms - executed_ms - intervening_journal_ms
            if min(action_ms, ready_ms, intervening_journal_ms) < -0.1:
                raise ValueError("Inconsistent timing boundaries")
            kind = action_kind(entry)
            row = {
                "step": number(planned["step"]),
                "kind": kind,
                "completedElapsedMs": completed_ms,
                "recordedActionAndWaitMs": action_and_wait_ms,
                "recordedModelLatencyMs": number(entry.get("modelMs", 0)),
                "reconstructedActionExecutionMs": action_ms,
                "reconstructedReadinessMs": ready_ms,
                "interveningJournalMs": intervening_journal_ms,
            }
            settled = evidence(entry["pageAfter"], event.get("page"))
            if kind == "product":
                before = evidence(planned["page"]["url"], planned["page"])
                immediate = evidence(executed["pageAfter"])
                row["productTransition"] = {
                    "plannedWithTargetIds": before["bothTargetProductIds"],
                    "executedWithTargetIds": immediate["bothTargetProductIds"],
                    "executedInTargetStore": immediate["sameStore"],
                    "settledWithTargetIds": settled["bothTargetProductIds"],
                    "settledWithVisibleExactTitle": settled["visibleExactProductTitle"],
                    "settledInTargetCategory": settled["sameStore"] and settled["targetCategory"],
                    "observedUrlRollback": immediate["sameStore"]
                    and immediate["bothTargetProductIds"]
                    and settled["sameStore"] and not settled["bothTargetProductIds"],
                }
            if first_category is None and kind == "category" and settled["sameStore"] and settled["targetCategory"]:
                first_category = {"step": row["step"], "elapsedMs": completed_ms}
            rows.append(row)
            planned = executed = None

    sums = (
        "recordedActionAndWaitMs", "recordedModelLatencyMs",
        "reconstructedActionExecutionMs", "reconstructedReadinessMs",
        "interveningJournalMs",
    )
    by_kind = {}
    for kind in sorted({row["kind"] for row in rows}):
        group = [row for row in rows if row["kind"] == kind]
        by_kind[kind] = {"count": len(group), **{
            key: rounded(sum(row[key] for row in group)) for key in sums
        }}
    totals = {key: rounded(sum(row[key] for row in rows)) for key in sums}
    product_rows = [row for row in rows if row["kind"] == "product"]
    model_latencies = [number(e["modelMs"]) for e in events
                       if e["type"] == "model_response_received"]
    source_hash = journal.get("sourceSha256", "")
    source_hash = source_hash if re.fullmatch(r"[0-9a-f]{64}", source_hash) else None
    known_implementation = source_hash == REFERENCE_SOURCE_SHA256
    status = result.get("status")
    reason = result.get("reason")
    checks = result.get("verification", {}).get("checks", {})
    summary = {
        "schemaVersion": 1,
        "journalSha256": hashlib.sha256(raw).hexdigest(),
        "recordedSourceSha256": source_hash,
        "outcome": {
            "status": status if status in ("incomplete", "reached_target", "interrupted") else "other",
            "reason": reason if reason in (None, "step_limit", "model_unavailable", "navigation_loop_detected", "product_detail_not_rendered") else "other",
            "independentVerificationPassed": result.get("verification", {}).get("passed") is True,
            "checks": {key: checks.get(key) is True for key in
                       ("store", "productId", "externalProductId", "visibleProduct")},
        },
        "recordedMetrics": measured,
        "completedActionCounts": dict(sorted(Counter(r["kind"] for r in rows).items())),
        "timing": {
            "postActionTotals": totals,
            "byActionKind": by_kind,
            "medianRecordedModelLatencyMs": rounded(statistics.median(model_latencies)) if model_latencies else None,
            "firstSettledTargetCategory": first_category,
            "elapsedAfterFirstSettledTargetCategoryMs": rounded(measured["totalMs"] - first_category["elapsedMs"]) if first_category else None,
            "categoryClicksAfterFirstSettledTargetCategory": sum(
                r["kind"] == "category" and r["step"] > first_category["step"] for r in rows
            ) if first_category else None,
        },
        "productEvidence": {
            "clicks": len(product_rows),
            "correctIdsImmediatelyAfterClick": sum(r["productTransition"]["executedWithTargetIds"] for r in product_rows),
            "observedUrlRollbacks": sum(r["productTransition"]["observedUrlRollback"] for r in product_rows),
            "settledVisibleExactTitles": sum(r["productTransition"]["settledWithVisibleExactTitle"] for r in product_rows),
        },
        "blockedMutations": {
            "recordedCount": number(result["blockedMutations"]),
            "requestTimingOrEndpointEvidenceAvailable": False,
            "causalLinkToProductRollbackEstablished": False,
        },
        "implementationDerivedStabilityFloor": {
            "knownReferenceSource": known_implementation,
            "readinessCallsInCompletedPath": 1 + len(rows),
            "perCallFloorMs": 700 if known_implementation else None,
            "minimumCombinedSettlingMs": 700 * (1 + len(rows)) if known_implementation else None,
            "additionalToRecordedTime": False,
        },
        "steps": rows,
        "methodology": {
            "scope": "Offline saved-journal analysis; no browser, server or API calls.",
            "recordedMetrics": "Copied numeric metrics. browserMs is totalMs minus modelMs minus journalMs, so it includes non-browser overhead. startPageMs and ageConfirmationMs overlap these totals.",
            "reconstruction": "For each paired planned/executed/completed action: actionStart = completed.elapsedMs - entry.actionAndWaitMs; actionExecution = executed.elapsedMs - actionStart; readiness = completed.elapsedMs - executed.elapsedMs - (completed.metrics.journalMs - executed.metrics.journalMs). Small bookkeeping overhead remains.",
            "postActionCoverage": "Reconstructed readiness excludes initial homepage readiness. Reconstructed action execution includes revalidation and local overhead. Recorded actionAndWaitMs includes the intervening journal write.",
            "rollback": "Both expected product IDs were present at action_executed but absent at step_completed in the same store. This proves an observed URL transition and rollback, not the cause or whether a title appeared transiently between observations.",
            "stabilityFloor": "Derived from the known reference source's 700 ms stable-observation requirement, once for initial readiness and once per completed action. This is an implementation lower bound, not measured sleep duration; it is included in recorded time. Unknown source hashes receive no floor estimate.",
            "blockedMutations": "Only an aggregate blocked request count was saved. Requests cannot be attributed to actions, endpoints or rollbacks; the count is non-causal evidence.",
            "privacy": "Only numeric metrics, fixed enum labels, verification booleans and SHA-256 digests are emitted. Raw URLs, product/store names, page text, addresses, account values, control labels, payloads and headers are omitted.",
            "limitations": "One incomplete run. This is not a successful-run latency, causal experiment, browser speedup estimate or success-rate comparison.",
        },
    }
    for row in summary["steps"]:
        for key in sums + ("completedElapsedMs",):
            row[key] = rounded(row[key])
    if first_category:
        first_category["elapsedMs"] = rounded(first_category["elapsedMs"])
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("journal", nargs="?", type=Path, default=DEFAULT_JOURNAL)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    try:
        summary = summarize(args.journal.read_bytes())
        encoded = json.dumps(summary, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        print("Analysis failed: unreadable journal/output or unsupported journal structure.", file=sys.stderr)
        return 1
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
