# Multilogin 403 diagnosis — 2026-09-25

Read-only probes from the `buena-multilogin` worker container against the live
workspace (`2b104092-39f8-459e-be4c-74e037507dd3`, EU launcher). No secret was
printed; the automation token was read from its mode-600 private file and used
only as an `Authorization` header. No profile was started, modified or reset
during the diagnosis.

## Exact failing endpoint

`GET https://api.multilogin.com/proxynm/connection_url?country=pl&protocol=socks5&session_type=sticky&count=1`

```
HTTP/1.1 403 Forbidden            (server: cloudflare, JSON body)
status.error_code = PROXY_TRAFFIC_EXHAUSTED
status.message    = "proxy traffic balance exhausted"
status.http_code  = 403
```

That is the endpoint `Multilogin.premiumProxy()` calls to provision the included
premium proxy, so the 403 is a business-level entitlement error, not a routing
or auth error.

## What still works

| probe | result |
| --- | --- |
| `GET /workspace/folders` | 200 JSON (token valid, workspace readable) |
| `POST /profile/metas` (ids: youtube-live-01) | 200 JSON; profile has `proxy: {type:socks5, port:1080}`, `proxy_masking: custom`, `in_use_by: ""` |
| `GET /api/v1/version` (launcher) | 200 |
| `GET /api/v1/profile/status/p/<id>` (launcher) | 200; profiles stopped, 01/02 show `validate_proxy_error` |
| `GET /proxynm/connection_url` (missing country) | 400 `BAD_REQUEST_VALUES` — endpoint shape and routing are correct |

Two non-routes were probed to rule out an API change: `GET /proxy/connection_url`
and `GET /user/plan` return the nginx HTML 403 (a different, non-JSON body),
which is what an unknown path looks like; the real endpoint answers structured
business errors. So the request shape in our code matches the current API.

## Launcher side

The launcher's own start path validates the profile's assigned proxy before it
launches a browser. Its log for every attempt:

```
error detecting ip: Get "https://proxy.multilogin.com/proxy/ip":
  socks connect tcp 51.195.126.60:1080->proxy.multilogin.com:443:
  unknown error connection not allowed by ruleset
couldn't get proxy connection ip data
GET /api/v2/profile/.../start -> 400
profile status -> validate_proxy_error
```

There is no observed "skip proxy validation" parameter in the launcher start
endpoint, and we did not invent one. A profile cannot be started while the gate
refuses the check connection.

## Interpretation of the 403 shape

- auth scope / stale token: **ruled out** — a read endpoint and profile metadata
  succeed with the same token in the same request.
- changed API endpoint: **ruled out** — the correct path returns structured
  validation errors; the wrong path returns nginx HTML.
- account lock / region restriction: **not indicated** — no lock or region
  error appears; the EU launcher and global API answer normally.
- exhausted proxy quota: **confirmed** — `PROXY_TRAFFIC_EXHAUSTED`, "proxy
  traffic balance exhausted". The SOCKS gate (`gate.multilogin.com:1080`) also
  refuses new check connections, which is consistent with a zero balance.
- plan/subscription: possible underlying cause of a zero balance, but the API
  reports it specifically as proxy traffic exhaustion, not as a plan error.

## Can any profile be reopened without the failing endpoint?

Yes in code, no in practice today:

- profile start does **not** call `proxynm`; it only asks the launcher to start
  the profile, and the profile already carries its assigned proxy (verified from
  metadata: socks5:1080, `proxy_masking: custom`);
- but the launcher itself refuses to start while its proxy IP check fails, so a
  start attempt fails with `validate_proxy_error` and the orchestrator (correctly)
  fails closed rather than rotating or stripping the proxy.

`reuseExistingProxy` mode (added with this diagnosis) performs exactly this safe
path: it proves the attachment from metadata, forbids provisioning/rotation, and
stops on a launcher proxy-validation failure. It never falls back to no proxy.

## Classification

**PLAN_OR_QUOTA** — `PROXY_TRAFFIC_EXHAUSTED` (proxy traffic balance exhausted)
on the workspace's premium-proxy provisioning endpoint, with the launcher's
proxy validation consequently failing. No code change, token scope change or API
change is implicated. Remediation is operator-side: restore the Multilogin proxy
traffic balance/entitlement (or explicitly approve a different proxy
entitlement), after which the same profiles can be reopened without any profile
change.
