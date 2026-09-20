#!/usr/bin/env python3
"""Publish an allowlisted, offline summary of a saved navigation comparison.

python3 analyze_comparison.py PRIVATE_BATCH --journals-dir PRIVATE_RUNS --output PUBLIC_JSON
python3 analyze_comparison.py --self-test

Only Python's standard library is used. This does not run browsers or make API
calls. Embedded tests use synthetic dictionaries and temporary files only.
"""

import argparse
import hashlib
import json
import math
import re
import statistics
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path


SEQUENCE = ("baseline", "candidate", "candidate", "baseline", "baseline", "candidate")
ARMS = {"baseline", "candidate"}
CHECKS = ("store", "productId", "externalProductId", "visibleProduct")
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
    "invalid_model_choice", "invalid_model_confidence", "provider_network_error",
    "cancelled_or_timed_out", "invalid_provider_json", "stale_recovery_limit",
    "comparison_cancelled", "comparison_source_changed", "comparison_protocol_invalid",
    "browser_close_failed", "comparison_baseline_source_drift", "comparison_failed",
    "candidate_stale_snapshot", "candidate_stale_recovery_limit",
}
COUNT_METRICS = (
    "actions", "modelActions", "policyActions", "modelCalls", "inputTokens", "outputTokens",
    "authorizedAgeConfirmations", "productOpenRollbacks", "executionAttempts", "staleSnapshots",
    "staleRecoveries", "fastReadinessCount", "fallbackReadinessCount", "completionReadinessCount",
    "readinessTimeoutCount",
)
TIME_METRICS = (
    "totalMs", "startPageMs", "modelMs", "browserMs", "journalMs", "ageConfirmationMs",
    "readinessMs", "observeMs", "executionMs",
)
METRICS = TIME_METRICS + COUNT_METRICS + ("estimatedModelUsd",)
HASH_LABELS = ("baseline", "candidate", "harness", "journal", "diagnostics", "lockfile")
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
SHA256 = re.compile(r"[a-f0-9]{64}")
MODEL = re.compile(r"jev-[a-z0-9.-]{1,60}")
EXPECTED_MODEL = "jev-1.13.0"


def object_value(value):
    if not isinstance(value, dict):
        raise ValueError("Unsupported object")
    return value


def number(value, integer=False):
    if value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Unsupported numeric field")
    if integer and (type(value) is not int or value > 2**53 - 1):
        raise ValueError("Unsupported count")
    return value


def boolean(value):
    return value if type(value) is bool else None


def digest(value):
    return value if isinstance(value, str) and SHA256.fullmatch(value) else None


def model_name(value):
    return value if isinstance(value, str) and MODEL.fullmatch(value) else None


def enum(value, allowed, missing="unrecorded"):
    return missing if value is None else value if isinstance(value, str) and value in allowed else "other"


def reason(value):
    if isinstance(value, str) and re.fullmatch(r"provider_http_[1-5][0-9]{2}", value):
        return value
    return enum(value, REASONS, missing=None)


def stats(values):
    known = [value for value in values if value is not None]
    total = sum(known) if all(type(value) is int for value in known) else math.fsum(known)
    return {"sampleCount": len(known), "total": total if known else None,
            "median": statistics.median(known) if known else None,
            "range": [min(known), max(known)] if known else None}


def source_summary(rows, field="recordedSourceSha256"):
    hashes = [row[field] for row in rows if row[field] is not None]
    complete = bool(rows) and len(hashes) == len(rows)
    return {"knownCount": len(hashes), "allAttemptsHaveHash": complete,
            "consistent": len(set(hashes)) == 1 if complete else None, "distinct": sorted(set(hashes))}


def agreement(rows, key):
    return {"matchingCount": sum(row[key] is True for row in rows),
            "mismatchingCount": sum(row[key] is False for row in rows),
            "unknownCount": sum(row[key] is None for row in rows)}


def model_summary(rows):
    versions = sorted({version for row in rows for version in row["observedModels"]["distinct"]})
    response_count = sum(row["observedModels"]["responseEventCount"] for row in rows)
    known_count = sum(row["observedModels"]["knownVersionCount"] for row in rows)
    complete = response_count > 0 and response_count == known_count
    mismatch = any(version != EXPECTED_MODEL for version in versions)
    return {"requested": sorted({row["requestedModel"] for row in rows if row["requestedModel"] is not None}),
            "distinct": versions, "responseEventCount": response_count, "knownVersionCount": known_count,
            "allResponseVersionsKnown": complete,
            "consistent": len(versions) == 1 if complete else False if len(versions) > 1 else None,
            "expectedVersion": EXPECTED_MODEL,
            "matchesExpected": False if mismatch else True if complete else None}


def summarize_attempt(row, raw_journal, ordinal):
    """Use the saved terminal journal where available; never expose private strings."""
    object_value(row)
    run = number(row.get("run"), integer=True)
    pair = number(row.get("pair"), integer=True)
    if run != ordinal or pair != (ordinal - 1) // 2 + 1:
        raise ValueError("Run/pair ordering mismatch")
    for key in ("browserLaunchMs", "fullAttemptMs", "blockedMutations"):
        number(row.get(key), integer=key == "blockedMutations")
    arm = enum(row.get("arm"), ARMS)
    journal = object_value(json.loads(raw_journal)) if raw_journal is not None else {}
    for key, expected in (("arm", row.get("arm")), ("run", run)):
        if key in journal and journal[key] != expected:
            raise ValueError("Journal association mismatch")
    result = object_value(journal.get("result") or {})
    for key in ("arm", "run", "pair", "journalId"):
        if key in result and result[key] != row.get(key):
            raise ValueError("Terminal result association mismatch")
    terminal = bool(result)
    events = journal.get("events", [])
    if not isinstance(events, list) or any(not isinstance(event, dict) for event in events):
        raise ValueError("Unsupported events")
    # A stopped/interrupted journal may contain useful spent-cost/timing counters
    # only in its last event. Keep that lower-bound evidence; never label it final.
    recorded = {}
    for event in events:
        if event.get("metrics") is not None:
            recorded.update(object_value(event["metrics"]))
    recorded.update(object_value(row.get("metrics") or {}))
    recorded.update(object_value(result.get("metrics") or {}))
    metrics = {key: number(recorded.get(key), integer=key in COUNT_METRICS) for key in METRICS}
    metrics_final = (isinstance(result.get("metrics"), dict) if terminal else
                     row.get("status") not in (None, "starting", "running") and isinstance(row.get("metrics"), dict))
    final = result if terminal else row
    status = enum(final.get("status", journal.get("status")), STATUSES)
    verification = object_value(final.get("verification") or {})
    checks = object_value(verification.get("checks") or {})
    public_checks = {key: boolean(checks.get(key)) for key in CHECKS}
    verified = (terminal and status == "reached_target" and verification.get("passed") is True
                and all(value is True for value in public_checks.values()))
    model_responses = sum(event.get("type") == "model_response_received" for event in events)
    observed_versions = [model_name(event.get("model")) for event in events if event.get("type") == "model_response_received"]
    usage_complete = boolean(recorded.get("usageComplete", final.get("usageComplete")))
    if not metrics_final or (metrics["modelCalls"] is not None and model_responses < metrics["modelCalls"]):
        usage_complete = False
    # A final batch result and its durable journal must agree before attributing
    # a success. If interrupted before finalization, a batch flag cannot fill it in.
    consistent = not terminal or row.get("status") in ("starting", "running") or all(
        key not in row or key not in result or row[key] == result[key]
        for key in ("status", "reason", "verification")
    )
    if not consistent:
        raise ValueError("Batch and journal outcomes disagree")
    return {"run": run, "pair": pair, "arm": arm, "status": status, "reason": reason(final.get("reason")),
            "verifiedSuccess": bool(verified), "independentVerificationPassed": boolean(verification.get("passed")),
            "verificationChecks": public_checks, "hasJournal": raw_journal is not None,
            "hasTerminalJournalResult": terminal, "usageComplete": usage_complete,
            "journalSha256": hashlib.sha256(raw_journal).hexdigest() if raw_journal is not None else None,
            "recordedSourceSha256": digest(journal.get("sourceSha256")),
            "baselineSourceSha256": digest(journal.get("baselineSourceSha256")),
            "requestedModel": model_name(journal.get("requestedModel")),
            "observedModels": {"responseEventCount": model_responses,
                               "knownVersionCount": sum(version is not None for version in observed_versions),
                               "distinct": sorted({version for version in observed_versions if version is not None})},
            "browserLaunchMs": number(final.get("browserLaunchMs", row.get("browserLaunchMs"))),
            "fullAttemptMs": number(final.get("fullAttemptMs", row.get("fullAttemptMs"))),
            "blockedMutations": number(final.get("blockedMutations", row.get("blockedMutations")), integer=True),
            "recordedModelResponseEvents": model_responses,
            "metricsFinal": bool(metrics_final), "metrics": metrics}


def summarize_arm(rows):
    successes = [row for row in rows if row["verifiedSuccess"]]
    failures = [row for row in rows if not row["verifiedSuccess"]]
    final_metrics = [row for row in rows if row["metricsFinal"]]
    final_failed_metrics = [row for row in failures if row["metricsFinal"]]
    partial_metrics = [row for row in rows if not row["metricsFinal"]]
    costs = stats(row["metrics"]["estimatedModelUsd"] for row in rows)
    complete = bool(rows) and all(row["usageComplete"] is True and row["metricsFinal"]
                                  and row["metrics"]["estimatedModelUsd"] is not None for row in rows)
    metric_stats = lambda subset, key: stats(row["metrics"][key] for row in subset)
    return {
        "attemptCount": len(rows), "verifiedSuccessCount": len(successes),
        "failedOrUnverifiedCount": len(failures),
        "unfinishedAttemptCount": sum(row["status"] in ("starting", "running") for row in rows),
        "statusCounts": dict(sorted(Counter(row["status"] for row in rows).items())),
        "failureReasonCounts": dict(sorted(Counter(row["reason"] or "unrecorded" for row in failures).items())),
        "missingJournalCount": sum(not row["hasJournal"] for row in rows),
        "nonterminalJournalCount": sum(row["hasJournal"] and not row["hasTerminalJournalResult"] for row in rows),
        "navigationTimeMs": {"verifiedCompleted": metric_stats(successes, "totalMs"),
                             "failedOrUnverified": metric_stats(final_failed_metrics, "totalMs"),
                             "allFinalizedAttempts": metric_stats(final_metrics, "totalMs"),
                             "partialRecordedElapsedLowerBounds": metric_stats(partial_metrics, "totalMs")},
        "fullAttemptTimeMs": {"verifiedCompleted": stats(row["fullAttemptMs"] for row in successes),
                              "failedOrUnverified": stats(row["fullAttemptMs"] for row in failures),
                              "allAttempts": stats(row["fullAttemptMs"] for row in rows)},
        "browserLaunchTimeMs": stats(row["browserLaunchMs"] for row in rows),
        "phaseTimeMs": {key: metric_stats(final_metrics, key) for key in TIME_METRICS if key != "totalMs"},
        "counts": {key: metric_stats(rows, key) for key in COUNT_METRICS},
        "blockedMutations": stats(row["blockedMutations"] for row in rows),
        "usageCompleteCount": sum(row["usageComplete"] is True for row in rows),
        "modelCostUsd": {"recordedAttemptCosts": costs, "knownRecordedTotal": costs["total"],
                         "allAttemptsComplete": complete,
                         "estimatedTotal": costs["total"] if complete else None,
                         "allAttemptCostPerVerifiedSuccess": costs["total"] / len(successes) if complete and successes else None,
                         "verifiedCompletedAttemptCosts": metric_stats(successes, "estimatedModelUsd"),
                         "failedOrUnverifiedAttemptCosts": metric_stats(failures, "estimatedModelUsd")},
        "sourceHashes": source_summary(rows), "baselineSourceHashes": source_summary(rows, "baselineSourceSha256"),
        "sourceMatchesProtocol": agreement(rows, "sourceMatchesProtocol"),
        "baselineSourceMatchesProtocol": agreement(rows, "baselineSourceMatchesProtocol"),
        "models": model_summary(rows),
    }


def paired_comparison(rows, ordered):
    pairs = []
    for pair_number in range(1, 4):
        selected = [row for row in rows if row["pair"] == pair_number]
        baseline = next((row for row in selected if row["arm"] == "baseline"), None)
        candidate = next((row for row in selected if row["arm"] == "candidate"), None)
        valid = bool(ordered and baseline and candidate and baseline["verifiedSuccess"] and candidate["verifiedSuccess"])
        pair = {"pair": pair_number, "attemptCount": len(selected), "bothVerified": valid,
                "navigationDeltaMs": None, "navigationSpeedup": None,
                "fullAttemptDeltaMs": None, "fullAttemptSpeedup": None}
        if valid:
            for name, getter in (("navigation", lambda row: row["metrics"]["totalMs"]),
                                 ("fullAttempt", lambda row: row["fullAttemptMs"])):
                before, after = getter(baseline), getter(candidate)
                if before is not None and after is not None:
                    pair[name + "DeltaMs"] = before - after
                    pair[name + "Speedup"] = before / after if after > 0 else None
        pairs.append(pair)
    return {"pairs": pairs, "bothVerifiedPairCount": sum(pair["bothVerified"] for pair in pairs),
            **{key: stats(pair[key] for pair in pairs) for key in
               ("navigationDeltaMs", "navigationSpeedup", "fullAttemptDeltaMs", "fullAttemptSpeedup")}}


def analyze(batch_raw, journals):
    """journals maps private UUID strings to bytes/None; identifiers never escape."""
    batch = object_value(json.loads(batch_raw))
    protocol = object_value(batch.get("protocol") or {})
    source = object_value(protocol.get("sourceHashes") or {})
    planned = protocol.get("sequence")
    if not isinstance(planned, list) or tuple(planned) != SEQUENCE:
        raise ValueError("Unsupported comparison protocol")
    results = batch.get("results")
    if not isinstance(results, list) or len(results) > len(SEQUENCE):
        raise ValueError("Unsupported attempts")
    ids, rows = set(), []
    for ordinal, result in enumerate(results, 1):
        object_value(result)
        identity = result.get("journalId")
        if not isinstance(identity, str) or not UUID.fullmatch(identity) or identity in ids:
            raise ValueError("Unsupported or duplicate journal identifier")
        ids.add(identity)
        raw = journals.get(identity)
        if raw is not None and object_value(json.loads(raw)).get("id") != identity:
            raise ValueError("Journal identity mismatch")
        row = summarize_attempt(result, raw, ordinal)
        expected = digest(source.get(row["arm"]))
        baseline = digest(protocol.get("baselineSourceSha256"))
        row["sourceMatchesProtocol"] = row["recordedSourceSha256"] == expected if row["recordedSourceSha256"] and expected else None
        row["baselineSourceMatchesProtocol"] = row["baselineSourceSha256"] == baseline if row["baselineSourceSha256"] and baseline else None
        rows.append(row)
    observed = [row["arm"] for row in rows]
    ordered = observed == list(SEQUENCE[:len(rows)])
    limits = object_value(protocol.get("limits") or {})
    pricing = object_value(batch.get("pricing") or {})
    return {
        "schemaVersion": 1, "protocol": {
            "name": "navigation-speed-v1", "allocation": "prespecified_counterbalanced_not_randomized",
            "plannedSequence": list(SEQUENCE), "observedSequence": observed,
            "plannedAttemptCount": len(SEQUENCE), "observedAttemptCount": len(rows),
            "unobservedAttemptCount": len(SEQUENCE) - len(rows), "observedOrderMatchesPlannedPrefix": ordered,
            "allPlannedAttemptsRecorded": ordered and len(rows) == len(SEQUENCE),
            "limits": {key: number(limits.get(key), integer=key == "maxStepsPerRun") for key in
                       ("maxStepsPerRun", "maxRunMs", "maxModelUsdPerRun")},
            "sourceHashes": {key: digest(source.get(key)) for key in HASH_LABELS},
            "baselineSourceSha256": digest(protocol.get("baselineSourceSha256")),
        },
        "batchSha256": hashlib.sha256(batch_raw).hexdigest(),
        "pricing": {key: number(pricing.get(key)) for key in ("inputUsdPerMillion", "outputUsdPerMillion")},
        "arms": {arm: summarize_arm([row for row in rows if row["arm"] == arm]) for arm in ("baseline", "candidate")},
        "unassignedAttemptCount": sum(row["arm"] not in ARMS for row in rows),
        "allAttempts": summarize_arm(rows), "pairedComparison": paired_comparison(rows, ordered), "attempts": rows,
        "methodology": {
            "scope": "Offline allowlist analysis of the private batch and its per-run durable journals; no live calls.",
            "success": "Success requires a terminal journal with reached_target, verification.passed=true and all four independent checks explicitly true. Missing journals and unverified runs remain counted attempts.",
            "timing": "Completed navigation and failed/unverified navigation times are separate and use finalized metrics only. Nonterminal snapshots are reported separately as elapsed lower bounds, never completed or failed speed samples. Navigation totalMs excludes browser launch. fullAttemptMs is reported only when recorded: before browser launch through close and diagnostic flush, excluding terminal journal and final batch writing. Missing durations remain null and statistics state available sample counts.",
            "phases": "Phase statistics cover attempts with finalized metrics. Baseline-only missing candidate metrics are null, never zero. readinessMs includes observeMs; startPageMs and ageConfirmationMs overlap other phases. browserMs is a residual, not an isolated browser measurement. Phase totals must not be summed. Counts from nonterminal snapshots can be lower bounds.",
            "cost": "Estimated model API cost excludes infrastructure and operator time. All-attempt cost per verified success includes failures. It is withheld if any attempt lacks finalized metrics, complete usage or recorded cost. Final batch metrics can preserve known costs after a terminal journal-write failure. Known recorded totals may be lower bounds when usage is incomplete; no missing call is treated as free.",
            "pairs": "Adjacent pairs contain one baseline and one candidate in the prescribed order. Only pairs with two independently verified successes contribute speed comparisons. Delta=baseline-candidate milliseconds; speedup=baseline/candidate, so values above one favor candidate. Failures still count in attempt, reliability and cost totals.",
            "limits": "Six prespecified counterbalanced attempts (three per arm) are descriptive, not randomized evidence or a population speedup estimate. Early stopping leaves later attempts unobserved, not successful or failed. No significance claim is made.",
            "models": "Actual model versions come only from model_response_received events, restricted to the jev model-name syntax. A requested alias is not evidence of the model served. Version disagreement or missing version evidence limits comparison; matchesExpected checks the predeclared jev-1.13.0 expectation.",
            "state": "Each attempt launches Chromium with the same persistent profile. Fresh browser contexts are not fresh accounts or fully cold sessions: cookies, local storage, disk/network caches and site state can carry over. Sequential order and variable site/network load can confound paired differences.",
            "privacy": "Only fixed enum labels, allowlisted numeric fields, booleans, bounded jev model-version names and SHA-256 digests are emitted. Task/account labels, environment strings, URLs, IDs, input paths, request/response content and arbitrary source-hash labels are omitted.",
        },
    }


def load_and_analyze(batch_path, journals_directory):
    raw = batch_path.read_bytes()
    batch = object_value(json.loads(raw))
    results = batch.get("results")
    if not isinstance(results, list):
        raise ValueError("Unsupported results")
    journals = {}
    for result in results:
        identity = object_value(result).get("journalId")
        if not isinstance(identity, str) or not UUID.fullmatch(identity):
            raise ValueError("Unsupported journal identifier")
        path = journals_directory / (identity + ".json")
        # Missing evidence is represented explicitly; other read errors fail.
        try:
            journals[identity] = path.read_bytes()
        except FileNotFoundError:
            journals[identity] = None
    return analyze(raw, journals)


def fixture():
    """Synthetic evidence only; never import or read a live journal in tests."""
    results, journals = [], {}
    for index, arm in enumerate(SEQUENCE, 1):
        identity = "00000000-0000-0000-0000-" + str(index).zfill(12)
        ms = 1000 if arm == "baseline" else 500
        row = {"arm": arm, "run": index, "pair": (index - 1) // 2 + 1, "journalId": identity,
               "status": "reached_target", "reason": None, "fullAttemptMs": ms + 100, "browserLaunchMs": 100,
               "verification": {"passed": True, "checks": dict.fromkeys(CHECKS, True)},
               "metrics": {"totalMs": ms, "modelMs": 100, "modelCalls": 1, "estimatedModelUsd": 0.001,
                           "inputTokens": 10, "outputTokens": 0, "usageComplete": True}}
        results.append(row)
        journals[identity] = json.dumps({"id": identity, "arm": arm, "run": index, "sourceSha256": "a" * 64,
            "baselineSourceSha256": "b" * 64, "result": row,
            "requestedModel": "jev-latest", "events": [{"type": "model_response_received", "model": EXPECTED_MODEL}]}).encode()
    batch = {"protocol": {"sequence": list(SEQUENCE), "sourceHashes": {"baseline": "b" * 64, "candidate": "c" * 64}},
             "results": results}
    return batch, journals


class AnalyzerTests(unittest.TestCase):
    def test_complete_pairs_and_missing_phase_metrics(self):
        batch, journals = fixture()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertEqual(report["pairedComparison"]["navigationSpeedup"]["median"], 2)
        self.assertEqual(report["pairedComparison"]["navigationDeltaMs"]["median"], 500)
        self.assertEqual(report["arms"]["baseline"]["verifiedSuccessCount"], 3)
        self.assertEqual(report["arms"]["candidate"]["phaseTimeMs"]["readinessMs"]["sampleCount"], 0)
        self.assertAlmostEqual(report["allAttempts"]["modelCostUsd"]["estimatedTotal"], .006)
        self.assertTrue(report["allAttempts"]["models"]["consistent"])
        self.assertTrue(report["allAttempts"]["models"]["matchesExpected"])

    def test_model_drift_is_visible_without_exposing_unknown_model_strings(self):
        batch, journals = fixture()
        identity = batch["results"][1]["journalId"]
        raw = json.loads(journals[identity]); raw["events"][0]["model"] = "jev-1.14.0"
        journals[identity] = json.dumps(raw).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertFalse(report["allAttempts"]["models"]["consistent"])
        self.assertFalse(report["allAttempts"]["models"]["matchesExpected"])
        raw["events"][0]["model"] = "private model / account"
        journals[identity] = json.dumps(raw).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertNotIn("private model", json.dumps(report))
        self.assertIsNone(report["allAttempts"]["models"]["consistent"])

    def test_failed_attempt_cost_is_included_and_missing_usage_is_not_free(self):
        batch, journals = fixture()
        row = batch["results"][1]
        row.update(status="incomplete", reason="step_limit")
        row["verification"]["passed"] = False
        raw = json.loads(journals[row["journalId"]]); raw["result"] = row
        journals[row["journalId"]] = json.dumps(raw).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        candidate = report["arms"]["candidate"]
        self.assertEqual(candidate["failedOrUnverifiedCount"], 1)
        self.assertAlmostEqual(candidate["modelCostUsd"]["allAttemptCostPerVerifiedSuccess"], .0015)
        self.assertEqual(report["pairedComparison"]["bothVerifiedPairCount"], 2)
        row["metrics"]["usageComplete"] = False
        raw["result"] = row; journals[row["journalId"]] = json.dumps(raw).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertIsNone(report["allAttempts"]["modelCostUsd"]["allAttemptCostPerVerifiedSuccess"])
        self.assertAlmostEqual(report["allAttempts"]["modelCostUsd"]["knownRecordedTotal"], .006)

    def test_private_fields_and_unknown_labels_do_not_escape(self):
        batch, journals = fixture()
        secret = "private-sensitive-account-marker"
        batch.update(task={"merchant": secret}, environment=secret, rawResponse=secret)
        batch["protocol"]["sourceHashes"][secret] = secret
        row = batch["results"][0]; row.update(status=secret, reason=secret, finalUrl="https://" + secret)
        raw = json.loads(journals[row["journalId"]]); raw.update(private=secret, result=row)
        raw["events"].append({"type": secret, "body": secret, "url": secret})
        journals[row["journalId"]] = json.dumps(raw).encode()
        encoded = json.dumps(analyze(json.dumps(batch).encode(), journals))
        self.assertNotIn(secret, encoded)
        self.assertNotIn(row["journalId"], encoded)

    def test_missing_journals_partial_batches_and_interrupted_metrics(self):
        batch, journals = fixture(); batch["results"] = batch["results"][:2]
        missing = batch["results"][0]["journalId"]; journals[missing] = None
        second = batch["results"][1]["journalId"]
        journals[second] = json.dumps({"id": second, "status": "interrupted", "result": None,
            "events": [{"type": "model_request_planned", "metrics": {"modelMs": 42}}]}).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertEqual(report["protocol"]["unobservedAttemptCount"], 4)
        self.assertEqual(report["allAttempts"]["attemptCount"], 2)
        self.assertEqual(report["allAttempts"]["verifiedSuccessCount"], 0)
        self.assertIsNone(report["allAttempts"]["modelCostUsd"]["estimatedTotal"])
        self.assertTrue(report["attempts"][1]["metricsFinal"])
        self.assertFalse(report["attempts"][1]["usageComplete"])

    def test_terminal_journal_failure_preserves_final_batch_cost(self):
        batch, journals = fixture()
        row = batch["results"][0]
        row.update(status="incomplete", reason="navigation_journal_failed")
        raw = json.loads(journals[row["journalId"]]); raw["result"] = None
        journals[row["journalId"]] = json.dumps(raw).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertEqual(report["allAttempts"]["verifiedSuccessCount"], 5)
        self.assertTrue(report["allAttempts"]["modelCostUsd"]["allAttemptsComplete"])
        self.assertAlmostEqual(report["allAttempts"]["modelCostUsd"]["allAttemptCostPerVerifiedSuccess"], .006 / 5)

    def test_starting_placeholders_use_durable_terminal_result_or_remain_partial(self):
        batch, journals = fixture(); batch["results"] = batch["results"][:1]
        row = batch["results"][0]
        batch["results"][0] = {key: row[key] for key in ("arm", "run", "pair", "journalId")}
        batch["results"][0]["status"] = "starting"
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertEqual(report["allAttempts"]["verifiedSuccessCount"], 1)
        raw = json.loads(journals[row["journalId"]]); raw["result"] = None
        raw["events"].append({"type": "action_planned", "metrics": {"totalMs": 150, "estimatedModelUsd": .001}})
        journals[row["journalId"]] = json.dumps(raw).encode()
        report = analyze(json.dumps(batch).encode(), journals)
        self.assertEqual(report["allAttempts"]["unfinishedAttemptCount"], 1)
        self.assertEqual(report["allAttempts"]["navigationTimeMs"]["failedOrUnverified"]["sampleCount"], 0)
        self.assertEqual(report["allAttempts"]["navigationTimeMs"]["partialRecordedElapsedLowerBounds"]["median"], 150)
        self.assertIsNone(report["allAttempts"]["modelCostUsd"]["estimatedTotal"])

    def test_invalid_associations_numbers_and_protocol_are_rejected(self):
        for change in (lambda b: b["results"][0].update(journalId="../../private"),
                       lambda b: b["results"][0].update(pair=3),
                       lambda b: b["protocol"].update(sequence=list(reversed(SEQUENCE))),
                       lambda b: b["results"][0].update(browserLaunchMs=True)):
            batch, journals = fixture(); change(batch)
            with self.assertRaises(ValueError):
                analyze(json.dumps(batch).encode(), journals)

    def test_file_loading_uses_only_synthetic_files(self):
        batch, journals = fixture()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); path = root / "batch.json"
            path.write_text(json.dumps(batch))
            for identity, raw in journals.items():
                (root / (identity + ".json")).write_bytes(raw)
            self.assertEqual(load_and_analyze(path, root)["allAttempts"]["verifiedSuccessCount"], 6)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", nargs="?", type=Path)
    parser.add_argument("--journals-dir", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AnalyzerTests))
        return 0 if result.wasSuccessful() else 1
    if args.batch is None or args.journals_dir is None or args.output is None:
        parser.error("batch, --journals-dir and --output are required unless --self-test is used")
    try:
        output = args.output.resolve()
        if output == args.batch.resolve() or output.parent == args.journals_dir.resolve():
            raise ValueError("Output must not replace private evidence")
        report = load_and_analyze(args.batch, args.journals_dir)
        report["analyzerSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        encoded = json.dumps(report, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        print("Comparison analysis failed: unreadable input/output or unsupported evidence structure.", file=sys.stderr)
        return 1
    print("Public comparison summary written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
