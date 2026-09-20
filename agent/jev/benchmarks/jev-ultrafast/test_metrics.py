from metrics import summarize_usage


def test_no_calls_is_zero_but_rejected_request_is_unknown():
    assert summarize_usage([], [])["estimatedTotalModelUsd"] == 0
    rejected = summarize_usage(
        [{}], [{"provider": "jev", "httpStatus": 402, "usage": None}]
    )
    assert rejected["usageComplete"] is False
    assert rejected["estimatedJevUsd"] is None
    assert rejected["estimatedTotalModelUsd"] is None


def test_counts_successful_retry_usage_but_keeps_failed_attempt_unknown():
    responses = [
        {"provider": "jev", "httpStatus": 503, "usage": None},
        {
            "provider": "jev",
            "httpStatus": 200,
            "usage": {"input_tokens": 1000, "output_tokens": 100},
        },
    ]
    result = summarize_usage([{}, {}], responses)
    assert result["inputTokens"] == 1000
    assert result["apiAttempts"] == 2
    assert result["estimatedTotalModelUsd"] is None


def test_helper_cost_included_or_explicitly_unknown():
    jev = {
        "provider": "jev",
        "httpStatus": 200,
        "usage": {"input_tokens": 1000, "output_tokens": 100},
    }
    helper = {"provider": "text-helper", "httpStatus": 200, "usage": {"cost": 0.0001}}
    result = summarize_usage([{}, {}], [jev, helper])
    assert abs(result["estimatedTotalModelUsd"] - 0.000142) < 1e-12
    helper["usage"] = {"prompt_tokens": 100}
    result = summarize_usage([{}, {}], [jev, helper])
    assert result["reportedHelperUsd"] is None
    assert result["estimatedTotalModelUsd"] is None


def test_malformed_usage_does_not_become_free():
    for bad in (None, -1, True, "100"):
        result = summarize_usage(
            [{}],
            [
                {
                    "provider": "jev",
                    "httpStatus": 200,
                    "usage": {"input_tokens": bad, "output_tokens": 10},
                }
            ],
        )
        assert result["usageComplete"] is False
        assert result["estimatedTotalModelUsd"] is None
