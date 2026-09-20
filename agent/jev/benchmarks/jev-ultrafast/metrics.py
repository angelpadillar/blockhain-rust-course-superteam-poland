"""Cost accounting must distinguish unknown usage from free usage."""

import math


def summarize_usage(requests, responses):
    def token(value):
        return type(value) is int and value >= 0

    def money(value):
        return type(value) in (float, int) and math.isfinite(value) and value >= 0

    jev = [r for r in responses if r["provider"] == "jev"]
    helper = [r for r in responses if r["provider"] == "text-helper"]
    totals = {
        k: sum(
            (r.get("usage") or {}).get(k, 0)
            for r in jev
            if token((r.get("usage") or {}).get(k))
        )
        for k in ("input_tokens", "output_tokens")
    }
    known = len(requests) == len(responses) and all(
        r["httpStatus"] == 200
        and all(token((r.get("usage") or {}).get(k)) for k in totals)
        for r in jev
    )
    helper_known = all(
        r["httpStatus"] == 200 and money((r.get("usage") or {}).get("cost"))
        for r in helper
    )
    helper_cost = sum(
        (r.get("usage") or {}).get("cost", 0)
        for r in helper
        if money((r.get("usage") or {}).get("cost"))
    )
    estimate = totals["input_tokens"] * 0.042 / 1e6
    return {
        "apiAttempts": len(requests),
        "jevCalls": len(jev),
        "helperCalls": len(helper),
        "inputTokens": totals["input_tokens"],
        "outputTokens": totals["output_tokens"],
        "estimatedJevUsd": estimate if known else None,
        "reportedHelperUsd": helper_cost if helper_known else None,
        "estimatedTotalModelUsd": estimate + helper_cost
        if known and helper_known
        else None,
        "usageComplete": known and helper_known,
        "pricing": {
            "jevInputUsdPerMillion": 0.042,
            "jevOutputUsdPerMillion": 0,
            "excludes": ["VPS", "account setup", "operator time"],
        },
    }
