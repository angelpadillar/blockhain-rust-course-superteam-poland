#!/usr/bin/env python3
"""Summarize one private navigation journal offline using only public allowlists.

Usage: python3 summarize_navigation.py PRIVATE_JOURNAL --output PUBLIC_SUMMARY
No browser, server, network, API or non-stdlib dependencies are used.
"""

import argparse
import hashlib
import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path


METRICS = (
    "totalMs", "startPageMs", "modelMs", "browserMs", "journalMs", "actions",
    "modelActions", "policyActions", "modelCalls", "inputTokens", "outputTokens",
    "estimatedModelUsd", "authorizedAgeConfirmations", "ageConfirmationMs",
    "productOpenRollbacks",
)
STATUSES = {"starting", "running", "incomplete", "reached_target", "interrupted"}
REASONS = {
    "step_limit", "model_unavailable", "navigation_loop_detected", "product_detail_not_rendered",
    "product_open_rollback_limit", "navigation_journal_failed", "navigation_time_limit",
    "navigation_model_budget", "navigation_error", "startup_failed", "evaluation_failed",
    "browser_launch_failed", "merchant_site_unavailable", "browser_challenge",
    "destination_requires_setup", "outside_navigation_pages", "wrong_navigation_start",
    "no_navigation_actions", "too_many_navigation_choices", "stale_or_forbidden_navigation",
    "navigation_control_unavailable", "navigation_page_changed", "homepage_link_unavailable",
    "age_confirmation_requires_user", "age_confirmation_not_dismissed", "repeated_age_confirmation_prompt",
    "age_confirmation_not_authorized_for_case", "age_confirmation_wrong_store",
    "age_confirmation_dialog_not_found", "unexpected_age_confirmation_terms",
    "unexpected_age_confirmation_controls", "ambiguous_closed_notice", "provider_usage_missing",
    "process_ended_before_final_result", "profile_in_use_or_stale_lock", "AbortError", "TimeoutError",
    "invalid_model_probabilities", "invalid_probability_total", "choice_probability_mismatch",
}
METHODS = {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "CONNECT", "TRACE", "OTHER"}
ENDPOINTS = {"cart", "basket", "order", "payment", "transaction", "address"}
ENDPOINT_SEGMENTS = {
    "v1", "v2", "v3", "v4", "v5", "stores", "addresses", "address", "products", "product",
    "details", "view", "catalog", "catalogue", "search", "availability", "collections", "menus",
    "cart", "carts", "basket", "baskets", "orders", "order", "payments", "payment", "transactions", "transaction",
}
ACTION_TYPES = {"click", "fill", "press", "authorized_site_confirmation"}
OUTCOMES = {
    "completion_verified", "product_open_rolled_back", "no_change", "page_changed",
    "age_confirmation_persisted", "age_confirmation_dismissed",
}
CHECKS = ("store", "productId", "externalProductId", "visibleProduct")
TRANSITION_CHECKS = ("targetIdsAfterExecute", "targetIdsObservedDuringWait", "targetIdsObservedInNavigation",
                     "targetIdsAfterWait", "visibleExactTitleAfterWait")


def enum(value, allowed, missing="unrecorded"):
    if value is None:
        return missing
    return value if isinstance(value, str) and value in allowed else "other"


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Unsupported numeric field")
    return value


def sequence(value):
    return value if type(value) is int and 0 < value <= 2**53 - 1 else None


def boolean(value):
    return value if type(value) is bool else None


def counts(values):
    return dict(sorted(Counter(values).items()))


def endpoint_template(value):
    """Independently sanitize a recorded template; never trust its producer."""
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//"):
        return None
    path = value.split("?", 1)[0].split("#", 1)[0]
    segments = [segment for segment in path.split("/") if segment][:24]
    return "/" + "/".join(segment.lower() if segment.lower() in ENDPOINT_SEGMENTS else ":segment" for segment in segments)


def summarize(raw):
    journal = json.loads(raw)
    result = journal.get("result") or {}
    events = journal.get("events", [])
    metrics = result.get("metrics") or {}
    if not isinstance(journal, dict) or not isinstance(result, dict) or not isinstance(events, list) or not isinstance(metrics, dict):
        raise ValueError("Unsupported journal structure")
    recorded_metrics = {key: number(metrics[key]) for key in METRICS if key in metrics}
    source_hash = journal.get("sourceSha256")
    if not isinstance(source_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_hash):
        source_hash = None
    status = enum(result.get("status", journal.get("status")), STATUSES)
    raw_reason = result.get("reason")
    reason = enum(raw_reason, REASONS, missing=None)
    if isinstance(raw_reason, str) and re.fullmatch(r"provider_http_[1-5][0-9]{2}", raw_reason):
        reason = raw_reason
    verification = result.get("verification") or {}
    checks = verification.get("checks") or {}
    independent_passed = boolean(verification.get("passed"))
    usage_complete = boolean(metrics.get("usageComplete", result.get("usageComplete")))

    planned_types, completed, diagnostics = {}, {}, []
    active_sequence = None
    for event in events:
        if not isinstance(event, dict):
            raise ValueError("Unsupported event structure")
        event_type = event.get("type")
        if event_type in ("action_planned", "action_executed"):
            active_sequence = sequence(event.get("step"))
            if active_sequence is not None:
                kind = event.get("kind")
                if event.get("action") == "repeat_scoped_age_confirmation":
                    kind = "authorized_site_confirmation"
                if event_type == "action_planned" or kind is not None:
                    planned_types[active_sequence] = enum(kind, ACTION_TYPES)
        elif event_type == "step_completed":
            entry = event.get("entry") or {}
            step = sequence(entry.get("step")) or active_sequence
            # Older age-confirmation entries omit step; their immediately
            # preceding planned/executed event supplies the explicit sequence.
            if step is None or step in completed:
                raise ValueError("Missing or duplicate completed step")
            row = {"actionSequence": step,
                   "actionType": enum(entry.get("kind"), ACTION_TYPES) if entry.get("kind") is not None
                   else planned_types.get(step, "unrecorded"),
                   "outcome": enum(entry.get("outcome"), OUTCOMES)}
            for source, target in ((event, "elapsedMs"), (entry, "actionAndWaitMs"), (entry, "modelMs")):
                if source.get(target) is not None:
                    row[target] = number(source[target])
            transition = entry.get("productTransition") or {}
            if transition:
                row["productTransition"] = {key: boolean(transition.get(key)) for key in TRANSITION_CHECKS}
            completed[step] = row
            active_sequence = None
        elif event_type == "navigation_mutation_blocked":
            diagnostics.append({"method": enum(event.get("method"), METHODS),
                                "endpointClass": enum(event.get("endpointClass"), ENDPOINTS),
                                "endpointTemplate": endpoint_template(event.get("endpointTemplate")),
                                "actionSequence": sequence(event.get("actionSequence")),
                                "actionType": enum(event.get("actionType"), ACTION_TYPES)})

    by_action = Counter((d["actionSequence"], d["actionType"]) for d in diagnostics)
    by_step = defaultdict(list)
    by_outcome = defaultdict(lambda: {"completedSteps": 0, "completedStepsWithBlockedRequests": 0, "blockedRequests": 0})
    for diagnostic in diagnostics:
        step = diagnostic["actionSequence"]
        by_step[step].append(diagnostic)
        outcome = completed[step]["outcome"] if step in completed else "unattributed" if step is None else "no_completed_step"
        by_outcome[outcome]["blockedRequests"] += 1
    for step, row in sorted(completed.items()):
        requests = by_step[step]
        row.update(blockedRequests=len(requests), blockedByMethod=counts(d["method"] for d in requests),
                   blockedByEndpointClass=counts(d["endpointClass"] for d in requests),
                   blockedByEndpointTemplate=counts(d["endpointTemplate"] for d in requests if d["endpointTemplate"] is not None),
                   blockedWithoutEndpointTemplate=sum(d["endpointTemplate"] is None for d in requests))
        by_outcome[row["outcome"]]["completedSteps"] += 1
        by_outcome[row["outcome"]]["completedStepsWithBlockedRequests"] += bool(requests)

    recorded_count = number(result["blockedMutations"]) if result.get("blockedMutations") is not None else None
    successful = status == "reached_target" and independent_passed is True
    estimated_cost = recorded_metrics.get("estimatedModelUsd")
    cost_available = successful and usage_complete is True and estimated_cost is not None
    return {
        "schemaVersion": 1,
        "journalSha256": hashlib.sha256(raw.encode() if isinstance(raw, str) else raw).hexdigest(),
        "recordedSourceSha256": source_hash,
        "outcome": {"status": status, "reason": reason,
                    "independentVerificationPassed": independent_passed,
                    "checks": {key: boolean(checks.get(key)) for key in CHECKS},
                    "categoryContextMatches": boolean(verification.get("categoryContextMatches"))},
        "recordedMetrics": recorded_metrics,
        "browserLaunchMs": number(result["browserLaunchMs"]) if result.get("browserLaunchMs") is not None else None,
        "usageComplete": usage_complete,
        "cost": {"estimatedModelUsd": estimated_cost,
                 "costPerVerifiedSuccessUsd": estimated_cost if cost_available else None,
                 "note": "Single verified success with complete recorded model usage; excludes infrastructure and operator time."
                 if cost_available else "Cost per success is unavailable for a failed or unverified run, or when usage/cost is incomplete."},
        "blockedMutations": {
            "recordedCount": recorded_count,
            "diagnosticEventCount": len(diagnostics),
            "hasDiagnosticEvents": bool(diagnostics),
            "undetailedRequestCount": max(0, recorded_count - len(diagnostics)) if recorded_count is not None else None,
            "aggregateMatchesDiagnosticCount": recorded_count == len(diagnostics) if recorded_count is not None else None,
            "byMethod": counts(d["method"] for d in diagnostics),
            "byEndpointClass": counts(d["endpointClass"] for d in diagnostics),
            "byEndpointTemplate": counts(d["endpointTemplate"] for d in diagnostics if d["endpointTemplate"] is not None),
            "withoutEndpointTemplateCount": sum(d["endpointTemplate"] is None for d in diagnostics),
            "byActionSequenceAndType": [{"actionSequence": step, "actionType": kind, "count": count}
                for (step, kind), count in sorted(by_action.items(), key=lambda pair: (pair[0][0] or 0, pair[0][1]))],
            "byCompletedStepOutcome": [{"outcome": outcome, **totals} for outcome, totals in sorted(by_outcome.items())],
            "causalLinkEstablished": False,
        },
        "completedSteps": [completed[step] for step in sorted(completed)],
        "methodology": {
            "scope": "Offline allowlist summary of one saved journal; no browser or API calls.",
            "correlation": "Blocked requests are joined only by their recorded actionSequence to completed steps and recorded outcomes. Association during an action/observation is correlation, not evidence that a blocked request caused an outcome or rollback.",
            "missingEvidence": "Legacy aggregate counts cannot be attributed. Missing action sequence is unattributed; a recorded sequence without a completed step is no_completed_step. Missing recorded outcomes are unrecorded; they are not inferred from private page data.",
            "metrics": "Metrics are copied from allowlisted numeric fields. browserLaunchMs is separate from navigation totalMs and null when unrecorded. browserMs is a residual including non-browser overhead; startPageMs and ageConfirmationMs overlap other totals. Missing booleans are null, not false.",
            "privacy": "Only fixed enum labels, numeric metrics/counts/sequences, verification booleans, SHA-256 digests and independently sanitized endpoint templates are emitted. Templates retain at most 24 fixed allowlisted path literals; all other segments become :segment. Hosts, queries, raw URLs, names, labels, account values, IDs, request data, headers and bodies are omitted.",
            "limitations": "One journal does not establish a success rate, successful-run speedup, or causal effect. Cost per success is unavailable on failed runs.",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("journal", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.journal.resolve() == args.output.resolve():
            raise ValueError("Input and output must differ")
        summary = summarize(args.journal.read_bytes())
        encoded = json.dumps(summary, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        print("Summary failed: unreadable input/output or unsupported journal structure.", file=sys.stderr)
        return 1
    print("Public navigation summary written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
