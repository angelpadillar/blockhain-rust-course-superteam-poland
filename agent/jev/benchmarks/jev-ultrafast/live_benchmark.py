"""Explicit live experiment, not a unit test. Requires the private controller.

Retains upstream operation/target heads and Browser Harness. Adds navigation-only
execution gates, request redaction, durable evidence and independent verification.
"""

import argparse
import json
import os
import signal
import sys
import time
import uuid
from pathlib import Path

import httpx
from metrics import summarize_usage

parser = argparse.ArgumentParser()
parser.add_argument(
    "--variant", choices=["stock", "candidate-v1", "candidate-v2"], default="stock"
)
args = parser.parse_args()
os.umask(0o077)
root = Path("/results")
root.mkdir(parents=True, exist_ok=True)
run_id = (
    time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    + "-"
    + args.variant
    + "-"
    + uuid.uuid4().hex[:8]
)
journal = (root / (run_id + ".jsonl")).open("a")
started = time.perf_counter()


def record(event, **data):
    journal.write(
        json.dumps(
            {
                "event": event,
                "elapsedMs": (time.perf_counter() - started) * 1000,
                **data,
            }
        )
        + "\n"
    )
    journal.flush()
    os.fsync(journal.fileno())


controller = httpx.Client(base_url="http://127.0.0.1:9230", timeout=15)


def control(path, data=None):
    response = controller.post(path, json=data or {})
    response.raise_for_status()
    return response.json()


def alarm(*_):
    raise TimeoutError("evaluation_time_limit")


signal.signal(signal.SIGALRM, alarm)
print("Ready for credentials JSON on hidden stdin.", flush=True)
credentials = json.loads(sys.stdin.readline())
os.environ.update(
    BU_CDP_WS=controller.get("/status").json()["websocket"],
    BU_NAME="jev-" + run_id,
    BH_HOME="/tmp/jev-" + run_id,
    BH_TELEMETRY="0",
    BH_UPDATE_CHECK="0",
)
# Start the owned-browser bridge before placing model credentials in this process.
from browser_harness.admin import ensure_daemon  # noqa: E402

ensure_daemon()
os.environ["TYPESAFE_API_KEY"] = credentials.pop("typesafe")
for name in (
    "TEXT_MODEL_API_KEY",
    "TEXT_MODEL_BASE_URL",
    "TEXT_MODEL",
    "TEXT_MODEL_REASONING",
):
    if credentials.get(name):
        os.environ[name] = credentials[name]
credentials.clear()

from jev_ultrafast import model  # noqa: E402
from jev_ultrafast.agent import Agent  # noqa: E402
from jev_ultrafast.browser import StalePage  # noqa: E402

if args.variant == "candidate-v1":
    import prompts_v1 as prompts

    model.NEXT_ACTION, model.TARGET, model.TEXT_VALUE = (
        prompts.NEXT_ACTION,
        prompts.TARGET,
        prompts.TEXT_VALUE,
    )
elif args.variant == "candidate-v2":
    import prompts

    model.NEXT_ACTION, model.TARGET, model.TEXT_VALUE = (
        prompts.NEXT_ACTION,
        prompts.TARGET,
        prompts.TEXT_VALUE,
    )

task = json.loads(Path("/work/foczka-navigation.json").read_text())
responses, requests = [], []
original_post = model.post_json


def request_hook(request):
    request.extensions["bench_started"] = time.perf_counter()
    requests.append(
        {"provider": "jev" if request.url.host == "api.typesafe.ai" else "text-helper"}
    )
    record("api_attempt", provider=requests[-1]["provider"], attempt=len(requests))


def response_hook(response):
    response.read()
    try:
        body = response.json()
    except ValueError:
        body = {}
    item = {
        "provider": "jev"
        if response.request.url.host == "api.typesafe.ai"
        else "text-helper",
        "httpStatus": response.status_code,
        "usage": body.get("usage"),
        "model": body.get("model"),
        "latencyMs": (
            time.perf_counter() - response.request.extensions["bench_started"]
        )
        * 1000,
    }
    responses.append(item)
    record("api_response", **item)


model.CLIENT.event_hooks = {"request": [request_hook], "response": [response_hook]}


def costs():
    return summarize_usage(requests, responses)


def audited_post(url, key, body):
    cost = costs()
    if (
        len(requests) >= 30
        or not cost["usageComplete"]
        or cost["estimatedTotalModelUsd"] >= task["maxModelUsd"]
    ):
        raise RuntimeError("model_budget_or_unknown_usage")
    body = control("/redact", body)
    record("model_request", body=body)
    result = original_post(url, key, body)
    record("model_result", result=result)
    return result


model.post_json = audited_post
agent, verification, reason, status, init_ms = (
    None,
    None,
    "step_limit",
    "incomplete",
    None,
)
started = time.perf_counter()
record(
    "run_started",
    variant=args.variant,
    upstreamCommit="452c1ad2dd628008f1d5608f28158d76e49e6cc0",
    goal=task["instruction"],
    textHelperConfigured=bool(os.environ.get("TEXT_MODEL_API_KEY")),
    modifications=[
        "navigation execution gate",
        "private text redaction",
        "durable journal",
        "independent verification",
        "previously authorized scoped age confirmation",
    ],
)
signal.alarm(120)
try:
    agent = Agent(task["startUrl"], task["instruction"])
    init_ms = (time.perf_counter() - started) * 1000
    original_act = agent.browser.act

    def guarded_act(action, page, text=None):
        check = control("/guard", action)
        if not check["allowed"]:
            raise RuntimeError(check["reason"])
        record("action_planned", action=control("/redact", action), text=text)
        result = original_act(action, page, text=text)
        record("action_executed", actionId=action["id"], kind=action["kind"])
        return result

    agent.browser.act = guarded_act
    for step in range(task["maxSteps"] + 1):
        record("checkpoint_planned", scopedAgeConfirmationAuthorized=True)
        check = control("/checkpoint")
        # First-page hydration is outside the stock loop clock, inside total wall time.
        deadline = time.monotonic() + 8
        while (
            step == 0
            and not check["destinationVerified"]
            and not check["siteUnavailable"]
            and time.monotonic() < deadline
        ):
            time.sleep(0.2)
            check = control("/checkpoint")
        record("checkpoint", **check)
        verification = check
        if check["siteUnavailable"]:
            reason = "merchant_site_unavailable"
            break
        if step == 0 and not check["destinationVerified"]:
            reason = "destination_requires_setup"
            break
        if check["verification"]["passed"]:
            status, reason = "reached_target", None
            break
        if step == task["maxSteps"]:
            break
        if check["ageRepeated"] or step == 0:
            agent.state["page"] = agent.browser.observe(screenshot=False)
        # The complete raw snapshot can contain private guards: redact before journaling.
        record("page_observed", page=control("/redact", agent.state["page"]))
        try:
            agent.command("predict")
            decision = agent.state["decision"]
            record("decision", decision=control("/redact", decision))
            print(
                json.dumps(
                    {
                        "step": step + 1,
                        "operation": decision["operation"],
                        "choice": decision["choice"],
                        "modelMs": decision["latency_ms"],
                    }
                ),
                flush=True,
            )
            if decision["operation"] == "TYPE_TEXT" and not os.environ.get(
                "TEXT_MODEL_API_KEY"
            ):
                reason = "text_helper_key_missing"
                break
            agent.command("act", {"fingerprint": agent.state["page"]["fingerprint"]})
        except StalePage:
            record("stale_decision_discarded")
            agent.state["decision"] = None
            agent.state["page"] = agent.browser.observe(screenshot=False)
            continue
        if agent.state["status"] in {"done", "blocked"}:
            verification = control("/checkpoint")
            if verification["verification"]["passed"]:
                status, reason = "reached_target", None
            else:
                reason = (
                    "unverified_done"
                    if agent.state["status"] == "done"
                    else "model_blocked"
                )
            break
except Exception as error:
    reason = type(error).__name__ + ": " + str(error)[:240]
    record("run_error", reason=reason)
finally:
    signal.alarm(0)
    total_ms = (time.perf_counter() - started) * 1000
    result = {
        "runId": run_id,
        "variant": args.variant,
        "status": status,
        "reason": reason,
        "totalMs": total_ms,
        "agentInitMs": init_ms,
        "upstreamElapsedMs": agent.state["elapsed_ms"] if agent else None,
        "modelActions": len(agent.state["history"]) if agent else 0,
        "metrics": costs(),
        "verification": verification,
        "timingScope": "Agent creation/homepage navigation through independent verification, including benchmark guards/journaling; browser launch and daemon setup excluded.",
    }
    record("run_finished", result=result)
    path = root / (run_id + ".json")
    path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    if agent:
        agent.close()
    journal.close()
