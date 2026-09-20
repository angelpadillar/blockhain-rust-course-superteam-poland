#!/usr/bin/env python3
"""Offline v4 batch analysis. Emits timing/accounting only, never goals or URLs."""
import argparse
import hashlib
import json
import math
import re
import statistics
from collections import defaultdict
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[2]
SOURCE_ROOT = WORKSPACE / "hackathon/jev/experimental/browser-runtime-v4"
TIMINGS = ("totalMs", "taskMs", "planningMs", "navigationMs", "verificationMs", "journalMs",
           "providerSettlementMs", "finalizationMs", "contextSetupMs", "cleanupMs")
RUNTIME_METRICS = ("totalMs", "observationMs", "executionMs", "conditionWaitMs", "chooserMs", "eventMs",
                   "explicitProtocolCalls", "nativeActionAttempts", "chooserCalls", "staleRefreshes", "blockedRequests")


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def safe_label(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,120}", value) else "unknown"


def stats(values):
    valid = [value for value in values if number(value)]
    return {"n": len(valid), "mean": round(statistics.mean(valid), 6) if valid else None,
            "median": round(statistics.median(valid), 6) if valid else None,
            "min": min(valid) if valid else None, "max": max(valid) if valid else None}


def aggregate_hash(hashes):
    # Mirrors JSON.stringify on the insertion-ordered per-file map in JS.
    payload = json.dumps(hashes, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()


def inspect_sources(batch):
    initial, final = batch.get("sourceHashes"), batch.get("finalSourceHashes")
    expected_files = batch.get("sourceFiles")
    valid = isinstance(initial, dict) and isinstance(final, dict) and isinstance(expected_files, list)
    valid = valid and all(isinstance(key, str) and isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                          for key, value in initial.items())
    computed = aggregate_hash(initial) if valid else None
    files_match = valid and set(initial) == set(expected_files) and len(expected_files) == len(initial)
    initial_valid = valid and computed == batch.get("sourceSha256")
    final_matches = valid and initial == final
    current_matches = None
    missing = []
    if valid:
        current_matches = True
        for name, expected in initial.items():
            source = (SOURCE_ROOT / name).resolve()
            # Do not read arbitrary artifact-supplied paths outside this project.
            if not source.is_relative_to(WORKSPACE / "hackathon/jev") or not source.is_file():
                current_matches = False
                missing.append(safe_label(Path(name).name))
                continue
            if hashlib.sha256(source.read_bytes()).hexdigest() != expected:
                current_matches = False
    return {"reportedUnchanged": batch.get("sourceUnchanged") is True,
            "initialAggregateValid": bool(initial_valid), "sourceListComplete": bool(files_match),
            "finalHashesMatchInitial": bool(final_matches), "currentCheckoutMatches": current_matches,
            "missingOrDisallowedFiles": missing,
            "internallyConsistent": bool(initial_valid and files_match and final_matches and batch.get("sourceUnchanged") is True)}


def summarize(rows):
    costs = [row["costUsd"] for row in rows]
    complete_cost = all(number(cost) for cost in costs)
    calls = [row["modelCalls"] for row in rows]
    return {"attempted": len(rows), "verified": sum(row["verified"] for row in rows),
            "failedOrUnverified": sum(not row["verified"] for row in rows),
            "allAttemptMs": stats(row["timings"]["totalMs"] for row in rows),
            "verifiedAttemptMs": stats(row["timings"]["totalMs"] for row in rows if row["verified"]),
            "timings": {key: stats(row["timings"][key] for row in rows) for key in TIMINGS},
            "runtimeMetrics": {key: stats(row["runtimeMetrics"][key] for row in rows) for key in RUNTIME_METRICS},
            "modelMs": stats(row["modelMs"] for row in rows),
            "modelCalls": sum(calls) if all(number(value) for value in calls) else None,
            "knownModelCalls": sum(value for value in calls if number(value)),
            "unknownCallCountAttempts": sum(not number(value) for value in calls),
            "knownCostUsd": round(sum(row["knownCostUsd"] for row in rows if number(row["knownCostUsd"])), 10),
            "costUsd": round(sum(costs), 10) if complete_cost else None,
            "meanCostUsd": round(statistics.mean(costs), 10) if complete_cost and rows else None,
            "unknownCostAttempts": sum(not number(cost) for cost in costs),
            "unknownUsageAttempts": sum(not row["usageComplete"] for row in rows),
            "costBasis": sorted(set(row["costBasis"] for row in rows)),
            "sourceConsistentAttempts": sum(row["sourceConsistent"] for row in rows)}


def analyze(paths):
    cohorts, rows = [], []
    for path in dict.fromkeys(Path(path).resolve() for path in paths):
        batch = json.loads(path.read_text())
        integrity = inspect_sources(batch)
        cohort = {"batchId": safe_label(batch.get("batchId")), "mode": safe_label(batch.get("mode")),
                  "status": safe_label(batch.get("status")), "sourceSha256": safe_label(batch.get("sourceSha256")),
                  "sourceVerification": integrity, "plannedAttempts": batch.get("plannedAttempts"),
                  "recordedAttempts": len(batch.get("results", [])), "browserLaunchMs": batch.get("browserLaunchMs")}
        cohorts.append(cohort)
        for attempt in batch.get("results", []):
            accounting = attempt.get("accounting") or {}
            metrics = (attempt.get("runtime") or {}).get("metrics") or {}
            cost = accounting.get("costUsd")
            rows.append({"batchId": cohort["batchId"], "mode": cohort["mode"], "sourceSha256": cohort["sourceSha256"],
                         "attempt": attempt.get("attempt"), "caseId": safe_label(attempt.get("caseId")),
                         "repeat": attempt.get("repeat"), "inputMode": safe_label(attempt.get("inputMode")),
                         "status": safe_label(attempt.get("status")), "reason": safe_label(attempt.get("reason")) if attempt.get("reason") else None,
                         "verified": attempt.get("verifiedSuccess") is True and (attempt.get("verification") or {}).get("passed") is True,
                         "sourceConsistent": integrity["internallyConsistent"],
                         "timings": {key: attempt.get(key) if number(attempt.get(key)) else None for key in TIMINGS},
                         "runtimeMetrics": {key: metrics.get(key) if number(metrics.get(key)) else None for key in RUNTIME_METRICS},
                         "modelCalls": accounting.get("modelCalls") if number(accounting.get("modelCalls")) else None,
                         "modelMs": accounting.get("modelMs") if number(accounting.get("modelMs")) else None,
                         "costUsd": cost if accounting.get("costComplete") is True and number(cost) else None,
                         "knownCostUsd": accounting.get("knownCostUsd") if number(accounting.get("knownCostUsd")) else None,
                         "usageComplete": accounting.get("usageComplete") is True,
                         "costBasis": safe_label(accounting.get("costBasis"))})
    grouped = defaultdict(list)
    for row in rows:
        grouped[(row["sourceSha256"], row["mode"], row["inputMode"])].append(row)
    groups = []
    for (source, mode, input_mode), group in sorted(grouped.items()):
        cases = defaultdict(list)
        for row in group:
            cases[row["caseId"]].append(row)
        groups.append({"sourceSha256": source, "mode": mode, "inputMode": input_mode, **summarize(group),
                       "cases": {name: summarize(case_rows) for name, case_rows in sorted(cases.items())}})
    return {"schemaVersion": 1, "methodology": {
        "scope": "Offline analysis of saved v4 synthetic fixture batches. No model or browser calls.",
        "grouping": "Source revision, benchmark mode and input mode remain separate. All attempts retained, including failures and missing measurements.",
        "timing": "Use batch timing definitions. Planning may overlap initial navigation; runtime conditionWaitMs overlaps observationMs. These phases must not be added or subtracted as exclusive buckets.",
        "cost": "Unknown cost/usage stays unknown; known spend is reported separately. Jev values remain estimates where labeled. No zero-cost inference from a missing ledger.",
        "sources": "Internal consistency checks initial aggregate and initial/final per-file hashes; current checkout match is separate and may change after a valid historical run. This does not authenticate an external artifact.",
    }, "cohorts": cohorts, "groups": groups, "attempts": rows}


def markdown(result):
    lines = ["| Source | Mode / input | Verified | Mean ms (all) | Median ms (all) | Range ms | Model calls | Known cost USD | Unknown cost attempts |",
             "|---|---|---:|---:|---:|---|---:|---:|---:|"]
    show = lambda value: "unknown" if value is None else f"{value:.3f}"
    for group in result["groups"]:
        timing = group["allAttemptMs"]
        lines.append(f"| {group['sourceSha256'][:12]} | {group['mode']} / {group['inputMode']} | {group['verified']}/{group['attempted']} | "
                     f"{show(timing['mean'])} | {show(timing['median'])} | {show(timing['min'])}–{show(timing['max'])} | "
                     f"{group['modelCalls'] if group['modelCalls'] is not None else 'unknown'} | {group['knownCostUsd']:.8f} | {group['unknownCostAttempts']} |")
    return "\n".join(lines) + "\n"


def self_test():
    assert stats([1, 3, None])["median"] == 2
    assert stats([None])["median"] is None
    assert not number(True)
    assert safe_label("https://private.invalid/path") == "unknown"
    base = {"verified": True, "timings": {key: None for key in TIMINGS}, "runtimeMetrics": {key: None for key in RUNTIME_METRICS},
            "modelMs": 1, "modelCalls": 1, "costUsd": 0.001, "knownCostUsd": 0.001, "usageComplete": True,
            "costBasis": "estimated", "sourceConsistent": True}
    first = {**base, "timings": {**base["timings"], "totalMs": 100}}
    second = {**base, "verified": False, "costUsd": None, "knownCostUsd": 0, "usageComplete": False,
              "timings": {**base["timings"], "totalMs": 900}}
    group = summarize([first, second])
    assert group["attempted"] == 2 and group["verified"] == 1
    assert group["allAttemptMs"]["mean"] == 500 and group["verifiedAttemptMs"]["median"] == 100
    assert group["costUsd"] is None and group["knownCostUsd"] == 0.001
    assert group["unknownCostAttempts"] == 1 and group["unknownUsageAttempts"] == 1
    hashes = {"fixture.mjs": "a" * 64}
    fake = {"sourceHashes": hashes, "finalSourceHashes": hashes, "sourceFiles": list(hashes), "sourceSha256": aggregate_hash(hashes), "sourceUnchanged": True}
    assert inspect_sources(fake)["internallyConsistent"]
    assert not inspect_sources({**fake, "sourceSha256": "b" * 64})["internallyConsistent"]
    assert not inspect_sources({**fake, "finalSourceHashes": {"fixture.mjs": "c" * 64}})["internallyConsistent"]
    print("analyzer self-tests passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batches", nargs="*", type=Path)
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-md", type=Path)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    paths = args.batches or sorted((Path(__file__).parent / "results").glob("*/batch.json"))
    result = analyze(paths)
    if args.output_json:
        args.output_json.parent.mkdir(parents=True, exist_ok=True)
        args.output_json.write_text(json.dumps(result, indent=2) + "\n")
    table = markdown(result)
    if args.output_md:
        args.output_md.parent.mkdir(parents=True, exist_ok=True)
        args.output_md.write_text(table)
    print(table, end="")


if __name__ == "__main__":
    main()
