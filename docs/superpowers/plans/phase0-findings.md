# Phase 0 findings

Measurements that the rest of the migration reads. Nothing here is filled from
memory — every value is an observation. See #64.

Status: **contract harness done, measurements pending.**

---

## GET /mcp traffic (Task 1)

The probe is in `src/index.ts` on both `/mcp` handlers. It logs the user-agent and
whether a session/auth header was present — no tokens, no header values.

`enableJsonResponse: true` means `POST /mcp` answers with `application/json`, so
`GET /mcp` is the **only** SSE surface in the server. Whether real clients open it
decides whether App Engine's request-duration behaviour matters at all.

- Window: _<start> → <end>_
- `POST /mcp` count: _<n>_
- `GET /mcp` count: _<n>_
- Clients that opened GET: _<user-agents>_
- Longest observed GET hold: _<duration, from log timestamps>_

Collect with:

```bash
docker compose logs app 2>&1 | grep -c '"probe":"GET /mcp"'
docker compose logs app 2>&1 | grep -c '"probe":"POST /mcp"'
docker compose logs app 2>&1 | grep '"probe":"GET /mcp"' | head -20
```

Exercise all three clients (Claude Code via `mcp-remote`, Claude Desktop,
claude.ai) at least once each before reading the counts.

**Gate:** GET count 0 across all three → SSE is not on the critical path and Task 3
tests request duration for completeness only. GET count > 0 → Task 3's SSE hold
test is a hard gate.

---

## HTTP contract harness (Task 2) — DONE

Recorded against the current Express server and pinned in
`src/tests/contract/http.test.ts` (45 assertions). Two deltas that Phase 3 (#67)
must handle deliberately:

**Method dispatch.** Express falls through to **404** for an unlisted method on a
known path (`POST /health`, `PUT /health`, `GET /oauth/token`, `GET /oauth/register`
all return 404 with `text/html`). `http-methods` returns **405**. Accepted change;
the contract assertions get amended in Phase 3 with a comment naming the cause.

**Trailing slashes.** An Express `Router` mounted with `app.use()` matches both the
bare and the slashed form, so **every** route currently serves its slashed variant:

| Path | Current status |
|---|---|
| `/health/` | 200 |
| `/.well-known/oauth-authorization-server/` | 200 |
| `/.well-known/oauth-protected-resource/` | 200 |
| `/.well-known/oauth-protected-resource/mcp/` | 200 |
| `/login/success/` | 200 |
| `/login/` | 400 |
| `/oauth/authorize/` | 400 |
| `/stats/` | 404 |
| `POST /api/login/` | 400 |

`http-hash` matches exact pathname segments and will 404 all of them. Phase 3 must
register both forms per route, or these break silently for any client that appends
a slash.

**Body handling.** Malformed JSON → **400**; a body over 100kb → **413**. Both are
`express.json()` defaults being silently re-implemented in Phase 3, so both are
pinned.

---

## GAE spike results (Task 3)

Spike sources are ready to deploy — they need a GCP project id, region, VPC
connector name and the Memorystore address before they can run.

| Question | `automatic_scaling` min=max=1 | `manual_scaling` instances=1 |
|---|---|---|
| SSE stream held for | _<N>s before cut_ | _<N>s before cut_ |
| `/drip` streamed or buffered | _<streamed \| buffered>_ | _<streamed \| buffered>_ |
| `X-Forwarded-For` shape | _<paste xff_split>_ | _<paste xff_split>_ |
| Memorystore reachable | _<yes/no>_ | _<yes/no>_ |
| Distinct `GAE_INSTANCE` observed | _<n>_ | _<n>_ |
| Cold start on first hit | _<yes/no>_ | _<yes/no>_ |

**Client-IP index:** with _<N>_ proxy hops observed, the client IP is
`xff_split[<index>]`. Phase 3's `clientIp()` (`TRUSTED_HOPS`) uses this.

**DECISION:** scaling mode = _<automatic|manual>_, because _<reason>_.

**Gate check against Task 1:** GET `/mcp` traffic was _<n>_; an SSE hold of _<N>_s
is _<sufficient|insufficient>_.

**If insufficient AND GET `/mcp` traffic > 0:** stop. App Engine Standard is not a
fit — escalate to Cloud Run before starting Phase 1 (#65).

---

## Cutover verification (Phase 4, #68)

_Filled at cutover._

## Soak results (Phase 5, #69)

_Filled after the 60-minute soak._
