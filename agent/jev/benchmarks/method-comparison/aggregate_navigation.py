#!/usr/bin/env python3
"""Aggregate public navigation summaries offline, using only stdlib allowlists.

Usage: python3 aggregate_navigation.py SUMMARY [SUMMARY ...] --output AGGREGATE
"""

import argparse
import json
import math
import re
import statistics
import sys
from collections import Counter
from pathlib import Path


STATUSES = {"starting", "running", "incomplete", "reached_target", "interrupted", "other", "unrecorded"}
METRICS = ("totalMs", "modelMs", "modelCalls", "estimatedModelUsd", "inputTokens", "outputTokens")


def number(value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Unsupported numeric field")
    return value


def stats(values):
    known = [value for value in values if value is not None]
    total = sum(known) if all(type(value) is int for value in known) else math.fsum(known)
    return {"sampleCount": len(known), "total": total if known else None,
            "mean": total / len(known) if known else None,
            "median": statistics.median(known) if known else None,
            "range": [min(known), max(known)] if known else None}


def aggregate(summaries):
    if not summaries:
        raise ValueError("No summaries")
    rows, hashes = [], []
    for index, summary in enumerate(summaries, 1):
        outcome = summary.get("outcome") or {}
        metrics = summary.get("recordedMetrics") or {}
        source_hash = summary.get("recordedSourceSha256")
        if isinstance(source_hash, str) and re.fullmatch(r"[a-f0-9]{64}", source_hash):
            hashes.append(source_hash)
        status = outcome.get("status")
        status = status if isinstance(status, str) and status in STATUSES else "other"
        rows.append({"run": index, "status": status,
                     "verifiedSuccess": status == "reached_target" and outcome.get("independentVerificationPassed") is True,
                     "usageComplete": summary.get("usageComplete") is True,
                     "browserLaunchMs": number(summary.get("browserLaunchMs")),
                     **{key: number(metrics.get(key)) for key in METRICS}})
    successes = sum(row["verifiedSuccess"] for row in rows)
    usage_complete = all(row["usageComplete"] for row in rows)
    cost = stats(row["estimatedModelUsd"] for row in rows)
    cost_complete = usage_complete and cost["sampleCount"] == len(rows)
    return {
        "schemaVersion": 1,
        "runCount": len(rows),
        "statusCounts": dict(sorted(Counter(row["status"] for row in rows).items())),
        "verifiedSuccessCount": successes,
        "sourceHashes": {"knownCount": len(hashes), "allRunsHaveHash": len(hashes) == len(rows),
                         "consistent": len(set(hashes)) == 1 if len(hashes) == len(rows) else None,
                         "distinct": sorted(set(hashes))},
        "navigationTimeMs": stats(row["totalMs"] for row in rows),
        "browserLaunchTimeMs": stats(row["browserLaunchMs"] for row in rows),
        "modelTimeMs": stats(row["modelMs"] for row in rows),
        "modelCalls": stats(row["modelCalls"] for row in rows),
        "modelUsage": {"completeRunCount": sum(row["usageComplete"] for row in rows),
                       "allRunsComplete": usage_complete,
                       "inputTokens": stats(row["inputTokens"] for row in rows),
                       "outputTokens": stats(row["outputTokens"] for row in rows)},
        "modelCostUsd": {**cost, "allRunCostsAndUsageComplete": cost_complete,
                         "totalCostPerVerifiedSuccess": cost["total"] / successes if cost_complete and successes else None},
        "runs": rows,
        "methodology": {
            "scope": "Offline aggregation of explicit saved public summaries; no live browser or API calls.",
            "timing": "Navigation time is recorded totalMs, from homepage navigation through verification including journal writes. Browser launch is reported separately and is never inferred or added to navigation time. Missing values remain null; each statistic reports its available sample count.",
            "cost": "Estimated model API costs only, excluding infrastructure, setup and operator time. Total cost per verified success divides all included attempt costs by verified successes, and is unavailable with no verified success or incomplete cost/usage evidence.",
            "verification": "A verified success requires recorded reached_target status and an explicitly true independent verification result.",
            "privacy": "Only fixed status labels, numeric values, booleans and validated source SHA-256 hashes are retained. Input paths, journal identifiers, URLs, names, labels, account values and request data are omitted.",
            "limitations": "This small sample of the recorded task does not establish a general success rate or cold-session performance. No Astra head-to-head benchmark is contained here; these results do not establish an Astra speedup or a causal comparison.",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("summaries", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        resolved = [path.resolve() for path in args.summaries]
        if args.output.resolve() in resolved or len(set(resolved)) != len(resolved):
            raise ValueError("Output must differ from unique inputs")
        result = aggregate([json.loads(path.read_bytes()) for path in args.summaries])
        encoded = json.dumps(result, indent=2, ensure_ascii=True, allow_nan=False) + "\n"
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, OverflowError):
        print("Aggregation failed: unreadable input/output or unsupported summary structure.", file=sys.stderr)
        return 1
    print("Public navigation aggregate written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
