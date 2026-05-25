# MCP Usage Analytics — Design Spec

Date: 2026-05-25
Status: Approved (design); ready for implementation planning.

## Goal

Understand how early users use the Lincx MCP server so we know what to improve.
Four questions to answer:

1. **Tool popularity & health** — which tools are called, how often, error rate, latency.
2. **Per-user adoption** — which users are active, what each uses, who tried once and dropped off.
3. **Usage sequences / funnels** — what order tools get called and where users stall.
4. **Errors & friction detail** — what failures users hit, so we fix the worst first.

In-house only: data lives in Redis (already in the stack); read via an authenticated
`/stats` HTTP endpoint. Calls are attributed to the **real** `user_id` / email.

## Non-goals

- No external analytics service (no PostHog/Tinybird) — keep usage data on-box.
- No precomputed rollup counters yet (compute `/stats` on read; revisit if volume grows).
- No dashboard UI — `/stats` returns JSON; a UI can be built on top later.
- No change to tool behavior, latency, or success/failure of any call.

## Architecture

Single source of truth: a **capped Redis event log**. Every tool call and resource
read appends one event. `/stats` reads the retained window and computes all four views
on demand. Rationale: one write path (no counter/stream drift), full fidelity for
sequences and error samples, and an in-memory fallback so dev works without Redis.
At early-user volume, scanning the capped window per `/stats` request is cheap.

```
tool/resource call
   │
   ▼
toolGuard wrapper ──► (returns result to caller immediately)
   │  (fire-and-forget, failure-isolated)
   ▼
recordEvent(event) ──► EventSink (Redis list, capped | in-memory ring buffer)
                                   ▲
                                   │  readEvents(limit)
GET /stats ──► computeStats(events) ──► JSON
```

### Capture point — `toolGuard.ts` (existing chokepoint)

`installToolGuards` already wraps every registered tool handler. Extend it to emit
one analytics event per call, **after** the result is produced, **fired non-blocking**
(never awaited before returning, wrapped so it can never throw or add latency).

Two correctness fixes required at this layer:

- **Status classification.** Today the guard marks `error` only on a thrown exception
  or an oversized response. But most tool failures are *returned* as
  `{ content: [{ text: "Error: …" }] }` and currently count as `ok`. Classify `error`
  when `result.isError` is set **or** the first text content begins with `Error:`.
- **`error_kind` derivation.** Map the failure to a small fixed enum — never store the
  raw message (it can contain IDs/PII):
  `not_authenticated | auth_expired | response_too_large | work_api_4xx |
  work_api_5xx | timeout | bad_params | other`.
  Derived from the existing error strings (`handleWorkApiError` prefixes) and the
  validateSession messages.

### Resource reads — `resources.ts`

Resource read callbacks bypass `toolGuard` today (a blind spot). Wrap them with the
same `recordEvent` call (`type: "resource"`, `name` = the resource/template name) so
`lincx://...` reads are counted.

### User attribution

The event carries the real `user_id` and `email`. `toolGuard` resolves them from
`extra.sessionId` (MCP transport id → `resolveLincxSession` → `getSessionStore().get`)
**inside the fire-and-forget path**, so the two store reads never add latency to the
tool call. If the session can't be resolved, the event is still recorded with
`user_id`/`email` omitted.

## Data model

One event per call:

```ts
interface UsageEvent {
  ts: number;                 // epoch ms
  type: "tool" | "resource";
  name: string;               // tool name or resource/template name
  status: "ok" | "error";
  error_kind?: ErrorKind;     // only when status === "error"
  duration_ms: number;
  response_chars: number;     // serialized result length (chars; see CHARACTER_LIMIT note)
  params_keys: string[];      // Object.keys(params) ONLY — never values
  user_id?: string;
  email?: string;
  mcp_session_id?: string;    // transport session id, for sequencing
}
```

### Privacy invariants (hard requirements)

- **Never** store `auth_token` or any OAuth token.
- **Never** store parameter *values* — only `Object.keys(params)`.
- **Never** store raw error messages — only the classified `error_kind`.
- `email` / `user_id` are stored deliberately (per product decision) for adoption
  analysis. They appear only in the analytics store and the authenticated `/stats`
  response, never in tool output to the model.
- All analytics logging continues to go via `console.error` (stderr) when logged —
  never `console.log` (project rule).

## Components

### `services/usageAnalytics.ts`

- `EventSink` interface: `append(event)`, `readRecent(limit)`.
  - **Redis impl:** `LPUSH usage:events <json>` then `LTRIM usage:events 0 CAP-1`.
    `readRecent` = `LRANGE usage:events 0 limit-1`.
  - **In-memory impl:** array ring buffer (dev / no `REDIS_URL`), mirrors `sessionStore`.
  - Selection mirrors `getKvStore()` (Redis when `REDIS_URL` set, else in-memory).
- `recordEvent(partial)`: resolves user (fire-and-forget), builds the event, appends.
  Fully wrapped in try/catch — analytics failure must never affect a tool call.
- `computeStats(events)`: **pure function**, returns the `/stats` payload (below).
  Pure so it is unit-testable without Redis.

### `routes/stats.ts`

- `GET /stats` → `computeStats(readRecent(WINDOW))` as JSON.
- Gated by `STATS_TOKEN` env: require `Authorization: Bearer <STATS_TOKEN>`.
  If `STATS_TOKEN` is unset, the route returns **404** (never accidentally public).
  A header gate is safe here — unlike `/mcp`, `/stats` is not in the OAuth discovery path.
- Optional `?limit=` to bound the window read (default = `USAGE_EVENT_CAP`).

### `constants.ts`

- `STATS_TOKEN` (default empty → `/stats` disabled).
- `USAGE_EVENT_CAP` (default `50_000` events — the retention window).

### `index.ts`

- Mount `statsRouter`. Wrap resource callbacks (or call `recordEvent` within them).

## `/stats` response shape

```jsonc
{
  "window": { "events": 1234, "oldest_ts": 0, "newest_ts": 0 },
  "tools": [
    { "name": "list_zones", "type": "tool", "calls": 0, "errors": 0,
      "error_rate": 0.0, "p50_ms": 0, "p95_ms": 0, "avg_chars": 0 }
  ],
  "users": [
    { "user_id": "...", "email": "...", "calls": 0, "distinct_tools": 0,
      "first_seen": 0, "last_seen": 0 }
  ],
  "errors": [ { "kind": "auth_expired", "count": 0, "sample_tool": "get_zone" } ],
  "sequences": {
    "recent": [ { "session": "...", "user_id": "...", "tools": ["list_zones","get_zone"] } ],
    "transitions": { "list_zones>get_zone": 0 }
  }
}
```

- **tools** answers popularity & health (sorted by calls desc).
- **users** answers adoption (distinct users, per-user breadth, first/last seen → drop-off).
- **errors** answers friction (counts by kind, a sample tool to start digging).
- **sequences** answers funnels (recent ordered per-session tool lists + an A→B
  transition map; full funnel analysis is done offline from this).

## Error handling

- `recordEvent` and the sink are fully failure-isolated: any throw is caught and
  swallowed (logged once to stderr at most). A tool call's result is never delayed
  or altered by analytics.
- Redis unavailable → in-memory sink (dev) or best-effort no-op (if Redis was expected
  but down, the catch swallows it; the tool call still succeeds).
- `/stats` with Redis down returns an empty/partial window rather than 500.

## Testing

- `computeStats` (pure): given a fixed event array, assert per-tool counts, `error_rate`,
  `p50`/`p95` latency, distinct-user counts, error grouping, and the transition map.
- In-memory `EventSink`: append beyond cap → oldest evicted; `readRecent` ordering.
- `toolGuard` classification: `ok` vs returned-`Error:` vs thrown vs oversized →
  correct `status`/`error_kind`; and that a thrown analytics path never breaks the call.
- `/stats` route: 404 when `STATS_TOKEN` unset; 401 on bad/missing bearer; 200 + valid
  JSON shape with token.

## Growth path (not now)

If event volume outgrows compute-on-read, add `HINCRBY` rollup counters for the
headline tool/user numbers (keeping the event log for sequences/errors). Documented
here so the upgrade is a known step, not a rewrite.
