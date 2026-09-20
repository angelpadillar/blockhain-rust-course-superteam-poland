#!/usr/bin/env python3
"""Offline summary of saved v3 paid fixture evidence; no network/browser imports.

Usage: python3 analyze_paid.py PATH/TO/batch.json [--output summary.json]
       python3 analyze_paid.py --self-test

Reads adjacent attempt-N.json files when present to recover a newer durable
ledger after interruption. Emits selected fields only, never goals, page data,
model content, image bytes, event bodies, credentials, or local paths.
"""

import argparse
import copy
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


IDENTITY = ("attempt", "suite", "caseId", "repeat", "mode", "guide", "planner")
SUITES = {"goal_pipeline", "semantic_guidance"}
GUIDES = {"jev", "openrouter-dom", "openrouter-dom-image"}
MODES = {"stepwise", "fast"}
CASES = {"enter-form", "live-search", "delayed-title", "semantic-context"}
CHECKS = ("localOrigin", "exactDetailRoute", "visibleExactTitle", "exactCollection")
TERMINAL = {"completed", "incomplete"}
TIMES = ("observationMs", "executionMs", "conditionWaitMs", "settlingMs", "chooserMs", "eventMs")
COUNTS = ("explicitProtocolCalls", "observations", "revalidations", "browserScans", "observerWakeups",
          "nativeActionAttempts", "nativeActionsCompleted", "chooserCalls", "staleRefreshes", "blockedRequests")


def obj(value):
    if not isinstance(value, dict):
        raise ValueError("Expected JSON object")
    return value


def number(value, integer=False):
    if value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid nonnegative numeric evidence")
    if integer and (type(value) is not int or value > 2**53 - 1):
        raise ValueError("Invalid count evidence")
    return value


def token(value, pattern=r"[a-zA-Z0-9_.:/ -]{1,160}"):
    return value if isinstance(value, str) and re.fullmatch(pattern, value) else None


def reason(value):
    return token(value, r"[a-z][a-z0-9_]{0,99}")


def stats(values):
    values = [value for value in values if value is not None]
    return {"count": len(values), "total": math.fsum(values) if values else None,
            "median": statistics.median(values) if values else None,
            "range": [min(values), max(values)] if values else None}


def agree(record, key, expected):
    if key not in record:
        return
    actual = record[key]
    same = (type(actual) in (int, float) and type(expected) in (int, float)
            and math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-12))
    if not same and (type(actual) is not type(expected) or actual != expected):
        raise ValueError("Ledger summary disagrees with individual calls: " + key)


def summarize_ledger(raw, terminal):
    if raw is None:
        return {"present": False, "calls": [], "modelCallAttempts": 0,
                "usageComplete": False, "costComplete": False, "costUsd": None,
                "knownCostUsd": 0, "inputTokens": None, "outputTokens": None,
                "knownInputTokens": 0, "knownOutputTokens": 0, "modelMs": None}
    raw = obj(raw)
    calls = raw.get("calls")
    if not isinstance(calls, list):
        raise ValueError("Missing individual model call ledger")
    clean = []
    for ordinal, source in enumerate(calls, 1):
        source = obj(source)
        if source.get("number") != ordinal:
            raise ValueError("Nonsequential model call ledger")
        if source.get("provider") not in {"openrouter", "typesafe"} or source.get("purpose") not in {"plan", "choose"}:
            raise ValueError("Unsupported provider or call purpose")
        if source.get("status") not in {"pending", "failed", "response_received"}:
            raise ValueError("Unsupported model call status")
        input_tokens = number(source.get("inputTokens"), True)
        output_tokens = number(source.get("outputTokens"), True)
        usage_complete = source.get("usageComplete") is True and input_tokens is not None and output_tokens is not None
        if source.get("usageComplete") is True and not usage_complete:
            raise ValueError("Complete usage lacks token counts")
        if (source["provider"] == "typesafe" and source.get("costBasis") == "estimated"
                and input_tokens is not None and source.get("costUsd") is not None):
            agree(source, "costUsd", input_tokens * 0.042 / 1e6)
        clean.append({"number": ordinal, "provider": source["provider"], "purpose": source["purpose"],
                      "status": source["status"], "image": source.get("image") is True,
                      "requestedModel": token(source.get("requestedModel")),
                      "actualModel": token(source.get("actualModel")),
                      "actualProvider": token(source.get("actualProvider")),
                      "providerTag": token(source.get("providerTag")),
                      "usageComplete": usage_complete, "inputTokens": input_tokens, "outputTokens": output_tokens,
                      "latencyMs": number(source.get("latencyMs")), "costUsd": number(source.get("costUsd")),
                      "costBasis": source.get("costBasis") if source.get("costBasis") in {"estimated", "provider_reported"} else None,
                      "isByok": source.get("isByok") if type(source.get("isByok")) is bool else None,
                      "upstreamInferenceCostUsd": number(source.get("upstreamInferenceCostUsd"))})
    complete_usage = all(call["usageComplete"] for call in clean)
    complete_cost = all(call["costUsd"] is not None for call in clean)
    known_cost = math.fsum(call["costUsd"] for call in clean if call["costUsd"] is not None)
    known_input = sum(call["inputTokens"] or 0 for call in clean)
    known_output = sum(call["outputTokens"] or 0 for call in clean)
    model_ms = math.fsum(call["latencyMs"] or 0 for call in clean)
    for key, value in (("modelCalls", len(clean)), ("usageComplete", complete_usage), ("costComplete", complete_cost),
                       ("costUsd", known_cost if complete_cost else None), ("knownCostUsd", known_cost),
                       ("inputTokens", known_input), ("outputTokens", known_output), ("modelMs", model_ms),
                       ("screenshotCalls", sum(call["image"] for call in clean))):
        agree(raw, key, value)
    return {"present": True, "calls": clean, "modelCallAttempts": len(clean),
            "usageComplete": terminal and complete_usage, "costComplete": terminal and complete_cost,
            "costUsd": known_cost if terminal and complete_cost else None, "knownCostUsd": known_cost,
            "inputTokens": known_input if terminal and complete_usage else None,
            "outputTokens": known_output if terminal and complete_usage else None,
            "knownInputTokens": known_input, "knownOutputTokens": known_output,
            "modelMs": model_ms if terminal and all(call["latencyMs"] is not None for call in clean) else None}


def summarize_attempt(raw):
    raw = obj(raw)
    if (raw.get("suite") not in SUITES or raw.get("guide") not in GUIDES or raw.get("mode") not in MODES
            or raw.get("caseId") not in CASES or raw.get("planner") not in {"openrouter", "none_fixed_task"}):
        raise ValueError("Unsupported fixture protocol")
    if raw.get("status") not in TERMINAL | {"starting"}:
        raise ValueError("Unsupported attempt status")
    terminal = raw["status"] in TERMINAL
    verification = obj(raw.get("verification") or {})
    checks = obj(verification.get("checks") or {})
    runtime = obj(raw.get("runtime") or {})
    metrics = obj(runtime.get("metrics") or {})
    success = (raw.get("status") == "completed" and raw.get("verifiedSuccess") is True
               and runtime.get("status") == "opened" and verification.get("passed") is True
               and all(checks.get(key) is True for key in CHECKS))
    if (raw.get("verifiedSuccess") is True or raw.get("status") == "completed") and not success:
        raise ValueError("Claimed success lacks independent completion evidence")
    ledger = summarize_ledger(raw.get("accounting"), terminal)
    calls = ledger["calls"]
    guide_calls = [call for call in calls if call["purpose"] == "choose"]
    row = {key: raw[key] for key in IDENTITY}
    number(row["attempt"], True); number(row["repeat"], True)
    row.update(status=raw["status"], reason=reason(raw.get("reason")), terminal=terminal, verifiedSuccess=success,
               verificationChecks={key: checks.get(key) if type(checks.get(key)) is bool else None for key in CHECKS},
               totalMs=number(raw.get("totalMs")) if terminal else None,
               navigationMs=number(raw.get("navigationMs")), planningMs=number(raw.get("planningMs")),
               contextSetupMs=number(raw.get("contextSetupMs")),
               runtimeMs=number(metrics.get("totalMs")) if terminal else None,
               runtimeMetrics={key: number(metrics.get(key), key in COUNTS) for key in TIMES + COUNTS},
               accounting=ledger,
               activations={"plannerCallAttempts": sum(call["purpose"] == "plan" for call in calls),
                            "guideCallAttempts": len(guide_calls),
                            "guideResponsesReceived": sum(call["status"] == "response_received" for call in guide_calls),
                            "imageCallAttempts": sum(call["image"] for call in calls),
                            "imageResponsesReceived": sum(call["image"] and call["status"] == "response_received" for call in calls),
                            "runtimeChooserInvocations": number(metrics.get("chooserCalls"), True)})
    row["guidanceComparisonActivated"] = bool(guide_calls) and (
        row["guide"] != "openrouter-dom-image" or any(call["image"] for call in guide_calls))
    return row


def aggregate(rows):
    successes = [row for row in rows if row["verifiedSuccess"]]
    failures = [row for row in rows if row["terminal"] and not row["verifiedSuccess"]]
    ledger = [row["accounting"] for row in rows]
    calls = [call for account in ledger for call in account["calls"]]
    cost_complete = bool(rows) and all(account["costComplete"] for account in ledger)
    usage_complete = bool(rows) and all(account["usageComplete"] for account in ledger)
    known_cost = math.fsum(account["knownCostUsd"] for account in ledger)
    cost = known_cost if cost_complete else None
    return {"attempts": len(rows), "successes": len(successes), "terminalFailures": len(failures),
            "unfinishedAttempts": len(rows) - len(successes) - len(failures),
            "failureReasons": dict(sorted(Counter(row["reason"] or "unrecorded" for row in failures).items())),
            "completedTotalMs": stats(row["totalMs"] for row in successes),
            "failedTotalMs": stats(row["totalMs"] for row in failures),
            "allTerminalTotalMs": stats(row["totalMs"] for row in rows if row["terminal"]),
            "completedRuntimeMs": stats(row["runtimeMs"] for row in successes),
            "allAttemptModelMs": stats(account["modelMs"] for account in ledger),
            "timingsAllAttempts": {key: stats(row[key] for row in rows) for key in ("planningMs", "navigationMs", "contextSetupMs")},
            "runtimeMetricsAllTerminalAttempts": {key: stats(row["runtimeMetrics"][key] for row in rows if row["terminal"])
                                                  for key in TIMES + COUNTS},
            "costComplete": cost_complete, "allAttemptCostUsd": cost, "knownCostLowerBoundUsd": known_cost,
            "costPerVerifiedSuccessUsdIncludingFailures": cost / len(successes) if cost is not None and successes else None,
            "usageComplete": usage_complete,
            "inputTokens": sum(account["knownInputTokens"] for account in ledger) if usage_complete else None,
            "outputTokens": sum(account["knownOutputTokens"] for account in ledger) if usage_complete else None,
            "knownInputTokens": sum(account["knownInputTokens"] for account in ledger),
            "knownOutputTokens": sum(account["knownOutputTokens"] for account in ledger),
            "costByBasisKnownUsd": {basis: math.fsum(call["costUsd"] for call in calls if call["costBasis"] == basis and call["costUsd"] is not None)
                                    for basis in ("provider_reported", "estimated")},
            "byokCallAttempts": sum(call["isByok"] is True for call in calls),
            "knownUpstreamInferenceCostUsdSeparate": math.fsum(call["upstreamInferenceCostUsd"] for call in calls
                                                              if call["upstreamInferenceCostUsd"] is not None),
            "modelCallAttempts": len(calls), "responsesReceived": sum(call["status"] == "response_received" for call in calls),
            "activations": {key: sum(row["activations"][key] or 0 for row in rows)
                            for key in ("plannerCallAttempts", "guideCallAttempts", "guideResponsesReceived",
                                        "imageCallAttempts", "imageResponsesReceived", "runtimeChooserInvocations")},
            "attemptsWithGuideActivated": sum(row["guidanceComparisonActivated"] for row in rows),
            "actualModelsByProvider": {provider: sorted({call["actualModel"] for call in calls
                                                       if call["provider"] == provider and call["actualModel"] is not None})
                                       for provider in ("openrouter", "typesafe")}}


def summarize(batch):
    batch = obj(batch)
    raw_rows, planned = batch.get("results"), batch.get("planned")
    if not isinstance(raw_rows, list) or not isinstance(planned, list) or len(raw_rows) > len(planned):
        raise ValueError("Invalid planned/observed attempt sequence")
    rows = []
    for index, raw in enumerate(raw_rows):
        if raw.get("attempt") != index + 1 or any(raw.get(key) != planned[index].get(key) for key in IDENTITY[1:]):
            raise ValueError("Attempt does not match frozen plan")
        rows.append(summarize_attempt(raw))
    groups = []
    for suite in ("goal_pipeline", "semantic_guidance"):
        key = "mode" if suite == "goal_pipeline" else "guide"
        for value in sorted({row[key] for row in rows if row["suite"] == suite}):
            selected = [row for row in rows if row["suite"] == suite and row[key] == value]
            groups.append({"suite": suite, "groupBy": key, "group": value, **aggregate(selected),
                           "byCase": {case: aggregate([row for row in selected if row["caseId"] == case])
                                      for case in sorted({row["caseId"] for row in selected})}})
    pairs = []
    for case in sorted(CASES):
        for repeat in sorted({row["repeat"] for row in rows}):
            matching = [row for row in rows if row["suite"] == "goal_pipeline" and row["caseId"] == case and row["repeat"] == repeat]
            arms = {row["mode"]: row for row in matching}
            if set(arms) != MODES or not all(row["verifiedSuccess"] and row["totalMs"] is not None for row in arms.values()):
                continue
            slow, fast = arms["stepwise"]["totalMs"], arms["fast"]["totalMs"]
            pairs.append({"caseId": case, "repeat": repeat, "stepwiseTotalMs": slow, "fastTotalMs": fast,
                          "savedMs": slow - fast, "stepwiseOverFast": slow / fast if fast > 0 else None})
    return {"schemaVersion": 1, "batchId": token(batch.get("batchId")),
            "sourceSha256": token(batch.get("sourceSha256"), r"[a-f0-9]{64}"),
            "sourceUnchanged": batch.get("sourceUnchanged") if type(batch.get("sourceUnchanged")) is bool else None,
            "nodeVersion": token(batch.get("nodeVersion"), r"v[0-9]+\.[0-9]+\.[0-9]+"),
            "sourceFiles": [file for file in batch.get("sourceFiles", [])
                            if token(file, r"(?:\.\./)*[a-zA-Z0-9_./-]{1,120}\.(?:mjs|json)")],
            "batchStatus": reason(batch.get("status")), "stopReason": reason(batch.get("stopReason")),
            "plannedAttempts": len(planned), "observedAttempts": len(rows), "unattempted": len(planned) - len(rows),
            "browserLaunchMs": number(batch.get("browserLaunchMs")), "browserVersion": token(batch.get("browserVersion")),
            "interpretation": [
                "Controlled synthetic search-and-open fixtures; not Glovo, an unseen-site benchmark, or general instruction-following evidence.",
                "Goal-pipeline arms share the real planner and new executor; stepwise adds 700 ms nonterminal waits. It is not the old deployed baseline.",
                "Semantic guidance uses the same fixed public task without goal planning; its image arm is DOM plus screenshot, not image-only.",
                "Costs include all recorded attempts and failures: OpenRouter reported account charges plus Jev token-based estimates. BYOK upstream amounts are separate, not added twice.",
                "Missing cost or unfinished evidence is unknown, never zero. Model call attempts include durable pending reservations; responses received confirm API activity separately.",
                "Total timing excludes browser/context setup, context close and final evidence writes. Planning overlaps initial navigation; observation and condition waits overlap. Do not add these components.",
                "Small repeated samples and successful matched pairs are descriptive only. Excluding failed pairs from timing does not erase failures from success or cost totals.",
                "Actual guidance/image activations are reported; rows with zero guide calls cannot support a guide comparison. Fresh contexts share one browser and do not prove cold caches.",
            ],
            "allAttempts": aggregate(rows), "groups": groups, "successfulMatchedPipelinePairs": pairs, "attempts": rows}


def load_batch(path):
    data = obj(json.loads(path.read_text()))
    for index, batch_row in enumerate(data.get("results", [])):
        attempt_path = path.parent / f"attempt-{index + 1}.json"
        if not attempt_path.is_file():
            continue
        attempt = obj(json.loads(attempt_path.read_text()))
        if any(attempt.get(key) != batch_row.get(key) for key in IDENTITY):
            raise ValueError("Batch/attempt association mismatch")
        if attempt.get("status") in TERMINAL and batch_row.get("status") in TERMINAL:
            if any(attempt.get(key) != batch_row.get(key) for key in ("status", "verifiedSuccess", "verification", "accounting", "totalMs")):
                raise ValueError("Terminal batch/attempt evidence disagrees")
        # The per-attempt journal is updated during calls; batch only between tasks.
        if batch_row.get("status") not in TERMINAL:
            data["results"][index] = attempt
    return data


class AnalyzerTests(unittest.TestCase):
    def row(self, **changes):
        call = {"number": 1, "provider": "typesafe", "purpose": "choose", "status": "response_received",
                "image": False, "usageComplete": True, "inputTokens": 500, "outputTokens": 20,
                "latencyMs": 100, "costUsd": 0.000021, "costBasis": "estimated", "actualModel": "jev-1.13.0"}
        row = {"attempt": 1, "suite": "goal_pipeline", "caseId": "semantic-context", "repeat": 1,
               "mode": "fast", "guide": "jev", "planner": "openrouter", "status": "completed", "verifiedSuccess": True,
               "totalMs": 1000, "runtime": {"status": "opened", "metrics": {"totalMs": 700, "chooserCalls": 1}},
               "verification": {"passed": True, "checks": {key: True for key in CHECKS}},
               "accounting": {"calls": [call]}}
        row.update(changes)
        return row

    def batch(self, rows):
        for index, row in enumerate(rows, 1):
            row["attempt"] = index
        return {"planned": [{key: row[key] for key in IDENTITY[1:]} for row in rows], "results": rows}

    def test_failures_in_cost_but_not_completed_timing(self):
        good = self.row()
        bad = self.row(status="incomplete", verifiedSuccess=False, totalMs=9000, reason="chooser_invalid_ref")
        result = summarize(self.batch([good, bad]))["allAttempts"]
        self.assertEqual((result["attempts"], result["successes"]), (2, 1))
        self.assertEqual(result["completedTotalMs"]["median"], 1000)
        self.assertEqual(result["failedTotalMs"]["median"], 9000)
        self.assertAlmostEqual(result["costPerVerifiedSuccessUsdIncludingFailures"], 0.000042)

    def test_unknown_cost_not_zero(self):
        row = self.row(status="incomplete", verifiedSuccess=False)
        row["accounting"]["calls"][0]["costUsd"] = None
        result = summarize(self.batch([row]))["allAttempts"]
        self.assertIsNone(result["allAttemptCostUsd"])
        self.assertFalse(result["costComplete"])

    def test_starting_keeps_known_cost_but_not_speed_or_complete_accounting(self):
        row = self.row(status="starting", verifiedSuccess=False)
        result = summarize(self.batch([row]))["allAttempts"]
        self.assertEqual(result["unfinishedAttempts"], 1)
        self.assertEqual(result["allTerminalTotalMs"]["count"], 0)
        self.assertEqual(result["knownCostLowerBoundUsd"], 0.000021)
        self.assertIsNone(result["allAttemptCostUsd"])

    def test_independent_checks_required(self):
        row = self.row()
        row["verification"]["checks"]["exactDetailRoute"] = False
        with self.assertRaises(ValueError):
            summarize(self.batch([row]))

    def test_accounting_arithmetic_checked(self):
        row = self.row()
        row["accounting"]["costUsd"] = 0
        with self.assertRaises(ValueError):
            summarize(self.batch([row]))

    def test_jev_estimate_recomputed(self):
        row = self.row()
        row["accounting"]["calls"][0]["costUsd"] = 0.01
        with self.assertRaises(ValueError):
            summarize(self.batch([row]))

    def test_pending_calls_are_not_received_responses(self):
        row = self.row(status="incomplete", verifiedSuccess=False)
        row["accounting"]["calls"][0].update(status="pending", usageComplete=False, inputTokens=None,
                                             outputTokens=None, latencyMs=None, costUsd=None)
        result = summarize(self.batch([row]))["allAttempts"]
        self.assertEqual(result["modelCallAttempts"], 1)
        self.assertEqual(result["responsesReceived"], 0)
        self.assertEqual(result["activations"]["guideResponsesReceived"], 0)
        self.assertFalse(result["costComplete"])

    def test_image_and_guidance_activation(self):
        row = self.row(suite="semantic_guidance", planner="none_fixed_task", guide="openrouter-dom-image")
        row["accounting"]["calls"][0].update(provider="openrouter", image=True, actualModel="google/gemini-2.5-flash-lite")
        result = summarize(self.batch([row]))["groups"][0]
        self.assertEqual(result["activations"]["imageResponsesReceived"], 1)
        self.assertEqual(result["attemptsWithGuideActivated"], 1)

    def test_zero_calls_no_guidance_comparison(self):
        row = self.row(accounting={"calls": []})
        result = summarize(self.batch([row]))["attempts"][0]
        self.assertFalse(result["guidanceComparisonActivated"])
        self.assertEqual(result["accounting"]["costUsd"], 0)

    def test_no_raw_text_emitted(self):
        row = self.row(goal="SECRET", events=[{"body": "SECRET"}], compiledTask={"query": "SECRET"})
        row["runtime"]["final"] = {"url": "SECRET"}
        row["accounting"]["calls"][0]["raw"] = "SECRET"
        self.assertNotIn("SECRET", json.dumps(summarize(self.batch([row]))))

    def test_recovery_from_adjacent_attempt(self):
        final = self.row()
        batch = self.batch([copy.deepcopy(final)])
        batch["results"][0].update(status="starting", verifiedSuccess=False, accounting=None)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "batch.json"
            path.write_text(json.dumps(batch))
            (path.parent / "attempt-1.json").write_text(json.dumps(final))
            self.assertEqual(summarize(load_batch(path))["allAttempts"]["successes"], 1)

    def test_successful_pairs_only(self):
        slow = self.row(mode="stepwise", totalMs=2000)
        fast = self.row(totalMs=1000)
        result = summarize(self.batch([slow, fast]))
        self.assertEqual(result["successfulMatchedPipelinePairs"][0]["stepwiseOverFast"], 2)
        fast.update(status="incomplete", verifiedSuccess=False)
        self.assertEqual(summarize(self.batch([slow, fast]))["successfulMatchedPipelinePairs"], [])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", nargs="?", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(AnalyzerTests))
        return 0 if result.wasSuccessful() else 1
    if args.batch is None:
        parser.error("batch.json is required")
    result = summarize(load_batch(args.batch))
    result["batchArtifactSha256"] = hashlib.sha256(args.batch.read_bytes()).hexdigest()
    rendered = json.dumps(result, indent=2, allow_nan=False) + "\n"
    if args.output:
        if args.output.resolve() == args.batch.resolve() or re.fullmatch(r"attempt-[0-9]+\.json", args.output.name):
            parser.error("output must not overwrite batch or attempt evidence")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    else:
        sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError) as error:
        print(f"Evidence validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
