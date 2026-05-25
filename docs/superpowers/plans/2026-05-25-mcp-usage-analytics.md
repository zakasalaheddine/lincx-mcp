# MCP Usage Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture every MCP tool call and resource read into a capped Redis event log and expose an authenticated `/stats` endpoint that reports tool health, per-user adoption, usage sequences, and error friction.

**Architecture:** A single source of truth — a capped Redis list of `UsageEvent`s (in-memory ring buffer when `REDIS_URL` is unset). The existing `toolGuard` chokepoint records one event per tool call (fire-and-forget, failure-isolated); resource read callbacks record their own. `GET /stats` reads the retained window and computes all views on demand via a pure `computeStats` function. Real `user_id`/email attribution; never stores tokens, param values, or raw error strings.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` imports), Express, ioredis, Zod, Vitest, supertest.

---

## File Structure

- `src/constants.ts` — **modify**: add `STATS_TOKEN`, `USAGE_EVENT_CAP`.
- `src/services/usageAnalytics.ts` — **create**: `UsageEvent`/`ErrorKind`/`UsageStats` types, `classifyResult`/`classifyErrorKind` (pure), `EventSink` (Redis + in-memory) + `getEventSink`, `recordEvent`/`recordEventAsync`, `computeStats` (pure).
- `src/middleware/toolGuard.ts` — **modify**: record a `tool` event on every exit path; pass `mcp_session_id`.
- `src/tools/resources.ts` — **modify**: record a `resource` event per read.
- `src/routes/stats.ts` — **create**: `GET /stats`, gated by `STATS_TOKEN`.
- `src/index.ts` — **modify**: mount `statsRouter`.
- `src/tests/usageAnalytics.test.ts` — **create**: classify, sink, recordEvent, computeStats.
- `src/tests/stats.route.test.ts` — **create**: endpoint auth gate + shape.
- `CLAUDE.md` — **modify**: document the analytics surface + privacy invariants.

---

## Task 1: Constants

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: Add the two env-backed constants**

Append to `src/constants.ts` (after the OAuth TTL block):

```ts
// ── Usage analytics ──────────────────────────────────────────────────────────
// Shared secret guarding GET /stats. Empty → /stats returns 404 (disabled).
export const STATS_TOKEN = process.env.STATS_TOKEN ?? "";

// Retention: max UsageEvents kept in the capped log (also the default /stats window).
export const USAGE_EVENT_CAP = parseInt(process.env.USAGE_EVENT_CAP ?? "50000", 10);
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build`
Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(analytics): add STATS_TOKEN + USAGE_EVENT_CAP constants"
```

---

## Task 2: Result classification (pure)

**Files:**
- Create: `src/services/usageAnalytics.ts`
- Test: `src/tests/usageAnalytics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/usageAnalytics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyResult } from "../services/usageAnalytics.js";

describe("classifyResult", () => {
  it("marks a normal result ok", () => {
    expect(classifyResult({ content: [{ type: "text", text: "{\"id\":\"1\"}" }] }))
      .toEqual({ status: "ok" });
  });

  it("detects a returned Error: text result (not just thrown / isError)", () => {
    const r = classifyResult({ content: [{ type: "text", text: "Error: Not authenticated. Use 'auth_login' first." }] });
    expect(r.status).toBe("error");
    expect(r.error_kind).toBe("not_authenticated");
  });

  it("classifies the oversized guard result via isError + body", () => {
    const r = classifyResult({ isError: true, content: [{ type: "text", text: "{\"error\":\"response_too_large\",\"size\":40000}" }] });
    expect(r).toEqual({ status: "error", error_kind: "response_too_large" });
  });

  it("maps known Work API error prefixes", () => {
    expect(classifyResult({ content: [{ type: "text", text: "Error: Your Lincx session has expired. Use 'auth_login'." }] }).error_kind).toBe("auth_expired");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Bad request — must have property" }] }).error_kind).toBe("bad_params");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Resource not found. Double-check the ID." }] }).error_kind).toBe("work_api_4xx");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Work API server error. Try again later." }] }).error_kind).toBe("work_api_5xx");
    expect(classifyResult({ content: [{ type: "text", text: "Error: Request timed out." }] }).error_kind).toBe("timeout");
    expect(classifyResult({ content: [{ type: "text", text: "Error: something weird" }] }).error_kind).toBe("other");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: FAIL — cannot import `classifyResult` (module/file does not exist).

- [ ] **Step 3: Create the module with types + classifiers**

Create `src/services/usageAnalytics.ts`:

```ts
/**
 * services/usageAnalytics.ts
 *
 * In-house usage analytics. Every tool call / resource read becomes one
 * UsageEvent in a capped log (Redis list, or in-memory ring buffer in dev).
 * GET /stats computes aggregates on read via computeStats().
 *
 * PRIVACY INVARIANTS (hard):
 *   - never store auth_token / OAuth tokens
 *   - never store parameter VALUES — only Object.keys(params)
 *   - never store raw error messages — only the classified error_kind
 *   - user_id / email are stored deliberately (adoption analysis), never sent to the model
 *
 * All logging here uses console.error (stderr), never console.log (project rule).
 */

export type ErrorKind =
  | "not_authenticated"
  | "auth_expired"
  | "response_too_large"
  | "work_api_4xx"
  | "work_api_5xx"
  | "timeout"
  | "bad_params"
  | "other";

export interface UsageEvent {
  ts: number;                  // epoch ms
  type: "tool" | "resource";
  name: string;
  status: "ok" | "error";
  error_kind?: ErrorKind;
  duration_ms: number;
  response_chars: number;
  params_keys: string[];       // keys only — never values
  user_id?: string;
  email?: string;
  mcp_session_id?: string;
}

/** Classify an error message string into a small fixed enum (never stored raw). */
export function classifyErrorKind(text: string): ErrorKind {
  if (/Not authenticated/i.test(text)) return "not_authenticated";
  if (/expired/i.test(text)) return "auth_expired";
  if (/response_too_large/.test(text)) return "response_too_large";
  if (/timed out/i.test(text)) return "timeout";
  if (/Bad request|Unprocessable/i.test(text)) return "bad_params";
  if (/Unauthorized|Forbidden|not found|Rate limit/i.test(text)) return "work_api_4xx";
  if (/server error/i.test(text)) return "work_api_5xx";
  return "other";
}

/**
 * Inspect an MCP tool/resource result for failure. Tools mostly RETURN errors as
 * `{ content: [{ text: "Error: ..." }] }` (not throws), and the oversized guard
 * sets isError — both count as errors here.
 */
export function classifyResult(result: unknown): { status: "ok" | "error"; error_kind?: ErrorKind } {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> } | null;
  const text = r?.content?.[0]?.text ?? "";
  const isErr = r?.isError === true || text.startsWith("Error:");
  if (!isErr) return { status: "ok" };
  return { status: "error", error_kind: classifyErrorKind(text) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/usageAnalytics.ts src/tests/usageAnalytics.test.ts
git commit -m "feat(analytics): UsageEvent types + result classification"
```

---

## Task 3: EventSink (in-memory + Redis)

**Files:**
- Modify: `src/services/usageAnalytics.ts`
- Test: `src/tests/usageAnalytics.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/tests/usageAnalytics.test.ts`:

```ts
import { getEventSink, type UsageEvent } from "../services/usageAnalytics.js";

const ev = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  ts: Date.now(), type: "tool", name: "list_zones", status: "ok",
  duration_ms: 5, response_chars: 100, params_keys: [], ...over,
});

describe("EventSink (in-memory)", () => {
  it("returns most-recent-first and evicts beyond the cap", async () => {
    const sink = await getEventSink();
    for (let i = 0; i < 5; i++) await sink.append(ev({ name: `t${i}` }));
    const recent = await sink.readRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].name).toBe("t4"); // newest first
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: FAIL — `getEventSink` not exported.

- [ ] **Step 3: Implement the sink**

Append to `src/services/usageAnalytics.ts`:

```ts
import { REDIS_URL, USAGE_EVENT_CAP } from "../constants.js";

export interface EventSink {
  append(event: UsageEvent): Promise<void>;
  readRecent(limit: number): Promise<UsageEvent[]>;
}

const EVENTS_KEY = "usage:events";
let _sink: EventSink | null = null;

export async function getEventSink(): Promise<EventSink> {
  if (_sink) return _sink;

  if (REDIS_URL) {
    const { Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    _sink = {
      async append(event) {
        await redis.lpush(EVENTS_KEY, JSON.stringify(event));
        await redis.ltrim(EVENTS_KEY, 0, USAGE_EVENT_CAP - 1);
      },
      async readRecent(limit) {
        const raw = await redis.lrange(EVENTS_KEY, 0, Math.max(0, limit - 1));
        return raw.map((r) => JSON.parse(r) as UsageEvent);
      },
    };
    console.error("[Analytics] Using Redis event log");
  } else {
    const buf: UsageEvent[] = []; // newest at index 0
    _sink = {
      async append(event) {
        buf.unshift(event);
        if (buf.length > USAGE_EVENT_CAP) buf.length = USAGE_EVENT_CAP;
      },
      async readRecent(limit) {
        return buf.slice(0, limit);
      },
    };
    console.error("[Analytics] No REDIS_URL — using in-memory event log (dev only)");
  }
  return _sink;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/usageAnalytics.ts src/tests/usageAnalytics.test.ts
git commit -m "feat(analytics): capped EventSink (Redis + in-memory)"
```

---

## Task 4: recordEvent (user resolution, fire-and-forget)

**Files:**
- Modify: `src/services/usageAnalytics.ts`
- Test: `src/tests/usageAnalytics.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/tests/usageAnalytics.test.ts`:

```ts
import { recordEventAsync } from "../services/usageAnalytics.js";
import { getSessionStore } from "../services/sessionStore.js";
import { bindMcpToLincxSession } from "../services/sessionManager.js";
import type { Session } from "../types.js";

describe("recordEventAsync", () => {
  it("resolves and attaches the real user from the mcp session id", async () => {
    const session: Session = {
      session_id: "lincx-rec", user_id: "u@x.com", email: "u@x.com",
      auth_token: "t", networks: [{ id: "n1", name: "N" }], active_network: "n1",
    };
    await (await getSessionStore()).set("lincx-rec", session);
    await bindMcpToLincxSession("mcp-rec", "lincx-rec");

    await recordEventAsync({
      type: "tool", name: "get_zone", status: "ok",
      duration_ms: 3, response_chars: 50, params_keys: ["id"], mcp_session_id: "mcp-rec",
    });

    const recent = await (await getEventSink()).readRecent(1);
    expect(recent[0].name).toBe("get_zone");
    expect(recent[0].user_id).toBe("u@x.com");
    expect(recent[0].email).toBe("u@x.com");
  });

  it("never throws when the session can't be resolved", async () => {
    await expect(recordEventAsync({
      type: "tool", name: "list_ads", status: "ok",
      duration_ms: 1, response_chars: 10, params_keys: [], mcp_session_id: "missing",
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: FAIL — `recordEventAsync` not exported.

- [ ] **Step 3: Implement recordEventAsync + recordEvent**

Append to `src/services/usageAnalytics.ts`:

```ts
import { resolveLincxSession } from "./sessionManager.js";
import { getSessionStore } from "./sessionStore.js";

type RecordInput = Omit<UsageEvent, "ts" | "user_id" | "email">;

/** Awaitable core — used by tests and by the fire-and-forget recordEvent. */
export async function recordEventAsync(input: RecordInput): Promise<void> {
  try {
    let user_id: string | undefined;
    let email: string | undefined;
    if (input.mcp_session_id) {
      const lincxId = await resolveLincxSession(input.mcp_session_id);
      if (lincxId) {
        const session = await (await getSessionStore()).get(lincxId);
        user_id = session?.user_id;
        email = session?.email;
      }
    }
    const event: UsageEvent = { ts: Date.now(), ...input, user_id, email };
    const sink = await getEventSink();
    await sink.append(event);
  } catch (err) {
    // Analytics must NEVER affect a tool call. Swallow (one stderr line).
    console.error("[Analytics] recordEvent failed:", err instanceof Error ? err.message : String(err));
  }
}

/** Fire-and-forget wrapper — callers must NOT await this. */
export function recordEvent(input: RecordInput): void {
  void recordEventAsync(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/usageAnalytics.ts src/tests/usageAnalytics.test.ts
git commit -m "feat(analytics): recordEvent with real user attribution"
```

---

## Task 5: computeStats (pure aggregation)

**Files:**
- Modify: `src/services/usageAnalytics.ts`
- Test: `src/tests/usageAnalytics.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/tests/usageAnalytics.test.ts`:

```ts
import { computeStats } from "../services/usageAnalytics.js";

describe("computeStats", () => {
  const base = { duration_ms: 10, response_chars: 100, params_keys: [] as string[] };
  const events: UsageEvent[] = [
    { ts: 100, type: "tool", name: "list_zones", status: "ok",    user_id: "a", email: "a@x", mcp_session_id: "s1", ...base },
    { ts: 200, type: "tool", name: "get_zone",   status: "ok",    user_id: "a", email: "a@x", mcp_session_id: "s1", ...base },
    { ts: 300, type: "tool", name: "report_query", status: "error", error_kind: "auth_expired", user_id: "b", email: "b@x", mcp_session_id: "s2", ...base },
  ];

  it("aggregates tool health, users, errors, and sequences", () => {
    const s = computeStats(events);

    const lz = s.tools.find((t) => t.name === "list_zones")!;
    expect(lz.calls).toBe(1);
    expect(lz.error_rate).toBe(0);

    const rq = s.tools.find((t) => t.name === "report_query")!;
    expect(rq.errors).toBe(1);
    expect(rq.error_rate).toBe(1);

    expect(s.users.find((u) => u.user_id === "a")!.distinct_tools).toBe(2);
    expect(s.errors.find((e) => e.kind === "auth_expired")!.count).toBe(1);
    expect(s.sequences.transitions["list_zones>get_zone"]).toBe(1);
    expect(s.window.events).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: FAIL — `computeStats` not exported.

- [ ] **Step 3: Implement computeStats + helpers**

Append to `src/services/usageAnalytics.ts`:

```ts
export interface UsageStats {
  window: { events: number; oldest_ts: number; newest_ts: number };
  tools: Array<{ name: string; type: "tool" | "resource"; calls: number; errors: number; error_rate: number; p50_ms: number; p95_ms: number; avg_chars: number }>;
  users: Array<{ user_id: string; email?: string; calls: number; distinct_tools: number; first_seen: number; last_seen: number }>;
  errors: Array<{ kind: ErrorKind; count: number; sample_tool: string }>;
  sequences: { recent: Array<{ session: string; user_id?: string; tools: string[] }>; transitions: Record<string, number> };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export function computeStats(events: UsageEvent[]): UsageStats {
  // ── tools ──
  const byTool = new Map<string, { type: "tool" | "resource"; calls: number; errors: number; durations: number[]; chars: number }>();
  for (const e of events) {
    const t = byTool.get(e.name) ?? { type: e.type, calls: 0, errors: 0, durations: [], chars: 0 };
    t.calls++; if (e.status === "error") t.errors++;
    t.durations.push(e.duration_ms); t.chars += e.response_chars;
    byTool.set(e.name, t);
  }
  const tools = [...byTool.entries()].map(([name, t]) => {
    const sorted = [...t.durations].sort((a, b) => a - b);
    return {
      name, type: t.type, calls: t.calls, errors: t.errors,
      error_rate: t.calls ? Math.round((t.errors / t.calls) * 100) / 100 : 0,
      p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95),
      avg_chars: t.calls ? Math.round(t.chars / t.calls) : 0,
    };
  }).sort((a, b) => b.calls - a.calls);

  // ── users ──
  const byUser = new Map<string, { email?: string; calls: number; tools: Set<string>; first: number; last: number }>();
  for (const e of events) {
    if (!e.user_id) continue;
    const u = byUser.get(e.user_id) ?? { email: e.email, calls: 0, tools: new Set<string>(), first: e.ts, last: e.ts };
    u.calls++; u.tools.add(e.name); u.first = Math.min(u.first, e.ts); u.last = Math.max(u.last, e.ts);
    byUser.set(e.user_id, u);
  }
  const users = [...byUser.entries()].map(([user_id, u]) => ({
    user_id, email: u.email, calls: u.calls, distinct_tools: u.tools.size, first_seen: u.first, last_seen: u.last,
  })).sort((a, b) => b.calls - a.calls);

  // ── errors ──
  const byErr = new Map<ErrorKind, { count: number; sample_tool: string }>();
  for (const e of events) {
    if (e.status !== "error" || !e.error_kind) continue;
    const x = byErr.get(e.error_kind) ?? { count: 0, sample_tool: e.name };
    x.count++; byErr.set(e.error_kind, x);
  }
  const errors = [...byErr.entries()].map(([kind, x]) => ({ kind, count: x.count, sample_tool: x.sample_tool }))
    .sort((a, b) => b.count - a.count);

  // ── sequences (group by session, chronological) ──
  const bySession = new Map<string, UsageEvent[]>();
  for (const e of events) {
    if (!e.mcp_session_id) continue;
    const arr = bySession.get(e.mcp_session_id) ?? [];
    arr.push(e); bySession.set(e.mcp_session_id, arr);
  }
  const transitions: Record<string, number> = {};
  const recent: UsageStats["sequences"]["recent"] = [];
  for (const [session, arr] of bySession) {
    arr.sort((a, b) => a.ts - b.ts);
    const toolNames = arr.map((e) => e.name);
    for (let i = 1; i < toolNames.length; i++) {
      const key = `${toolNames[i - 1]}>${toolNames[i]}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
    recent.push({ session, user_id: arr[0].user_id, tools: toolNames });
  }
  recent.sort((a, b) => (bySession.get(b.session)!.at(-1)!.ts) - (bySession.get(a.session)!.at(-1)!.ts));

  const tsList = events.map((e) => e.ts);
  return {
    window: { events: events.length, oldest_ts: tsList.length ? Math.min(...tsList) : 0, newest_ts: tsList.length ? Math.max(...tsList) : 0 },
    tools, users, errors,
    sequences: { recent: recent.slice(0, 50), transitions },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/usageAnalytics.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/services/usageAnalytics.ts src/tests/usageAnalytics.test.ts
git commit -m "feat(analytics): computeStats aggregation (tools/users/errors/sequences)"
```

---

## Task 6: Wire recording into toolGuard

**Files:**
- Modify: `src/middleware/toolGuard.ts`
- Test: `src/tests/toolGuard.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/tests/toolGuard.test.ts` (inside the existing file, after the current `describe` block):

```ts
import { getEventSink } from "../services/usageAnalytics.js";

describe("installToolGuards records usage events", () => {
  it("records a returned Error: result as a usage error", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.registerTool("err_tool", { description: "t", inputSchema: z.object({}).strict() },
      async () => ({ content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] }));
    installToolGuards(server);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = (server as any)._registeredTools["err_tool"];

    await tool.handler({}, { sessionId: "s-guard" });
    // recordEvent is fire-and-forget — let the microtask/append settle.
    await new Promise((r) => setTimeout(r, 20));

    const recent = await (await getEventSink()).readRecent(5);
    const rec = recent.find((e) => e.name === "err_tool");
    expect(rec?.status).toBe("error");
    expect(rec?.error_kind).toBe("not_authenticated");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/toolGuard.test.ts`
Expected: FAIL — `err_tool` event not found / status undefined (guard doesn't record yet).

- [ ] **Step 3: Integrate recordEvent into the wrapper**

In `src/middleware/toolGuard.ts`, add the import near the top (with the other imports):

```ts
import { recordEvent, classifyResult, classifyErrorKind } from "../services/usageAnalytics.js";
```

Replace the wrapper body (the `const first = handlerArgs[0]; ... return result; }` block shown in `installToolGuards`) with this version that captures the session id and records on every exit path:

```ts
      const first = handlerArgs[0];
      const params = (handlerArgs.length > 1 && first && typeof first === "object")
        ? (first as Record<string, unknown>)
        : {};
      const paramsKeys = Object.keys(params);
      const extra = handlerArgs[1] as { sessionId?: string } | undefined;
      const mcpSessionId = extra?.sessionId;
      const start = Date.now();

      let result: unknown;
      try {
        result = await original(...handlerArgs);
      } catch (err) {
        const duration = Date.now() - start;
        logMetrics({ tool: name, duration_ms: duration, response_chars: 0, params_keys: paramsKeys, status: "error" });
        recordEvent({ type: "tool", name, status: "error", error_kind: classifyErrorKind(err instanceof Error ? err.message : String(err)), duration_ms: duration, response_chars: 0, params_keys: paramsKeys, mcp_session_id: mcpSessionId });
        throw err;
      }

      let serialized = "";
      try {
        serialized = JSON.stringify(result) ?? "";
      } catch {
        serialized = "";
      }
      const bytes = serialized.length;
      const duration = Date.now() - start;

      if (bytes > RESPONSE_SIZE_LIMIT) {
        console.error(`[ToolGuard] ${name} response too large: ${bytes} chars (limit ${RESPONSE_SIZE_LIMIT}); params=[${paramsKeys.join(",")}]`);
        logMetrics({ tool: name, duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, status: "error" });
        recordEvent({ type: "tool", name, status: "error", error_kind: "response_too_large", duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, mcp_session_id: mcpSessionId });
        return oversizedResult(bytes);
      }

      const { status, error_kind } = classifyResult(result);
      logMetrics({ tool: name, duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, status });
      recordEvent({ type: "tool", name, status, error_kind, duration_ms: duration, response_chars: bytes, params_keys: paramsKeys, mcp_session_id: mcpSessionId });
      return result;
    };
```

Note: the existing `logMetrics` `status` field type is `"ok" | "error"`, which matches `classifyResult`'s return — no type change needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/toolGuard.test.ts`
Expected: PASS (existing 3 + new 1 = 4).

- [ ] **Step 5: Commit**

```bash
git add src/middleware/toolGuard.ts src/tests/toolGuard.test.ts
git commit -m "feat(analytics): record a usage event per tool call via toolGuard"
```

---

## Task 7: Instrument resource reads

**Files:**
- Modify: `src/tools/resources.ts`
- Test: `src/tests/resources.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/tests/resources.test.ts` (inside the existing `describe`, before its closing `});`):

```ts
  it("records a usage event when a resource is read", async () => {
    const { getEventSink } = await import("../services/usageAnalytics.js");
    api.on("GET", /^\/api\/campaigns\/c9$/, () => ({ id: "c9", name: "C" }));
    const server = build();
    const tmpl = server._registeredResourceTemplates["campaign-by-id"];

    await tmpl.readCallback(new URL("lincx://campaign/c9"), { id: "c9" }, extra);
    await new Promise((r) => setTimeout(r, 20));

    const recent = await (await getEventSink()).readRecent(5);
    const rec = recent.find((e) => e.type === "resource" && e.name === "campaign-by-id");
    expect(rec?.status).toBe("ok");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/resources.test.ts`
Expected: FAIL — no `resource` event recorded.

- [ ] **Step 3: Add a recording helper and use it in both read paths**

In `src/tools/resources.ts`, add the import:

```ts
import { recordEvent, classifyResult } from "../services/usageAnalytics.js";
```

Add this helper near the top of the file (after the `plain`/`json` helpers):

```ts
// Wrap a resource read so it emits one usage event (fire-and-forget).
async function recorded(
  name: string,
  extra: ResExtra,
  variables: Record<string, unknown> | undefined,
  read: () => Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }>,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  const start = Date.now();
  const result = await read();
  // Resource errors are returned as a text/plain "Error: ..." body — reuse the
  // tool classifier by adapting the contents text into the shape it expects.
  const { status, error_kind } = classifyResult({ content: [{ text: result.contents[0]?.text ?? "" }] });
  recordEvent({
    type: "resource", name, status, error_kind,
    duration_ms: Date.now() - start,
    response_chars: JSON.stringify(result).length,
    params_keys: variables ? Object.keys(variables) : [],
    mcp_session_id: extra?.sessionId,
  });
  return result;
}
```

Then wrap the two read callbacks. For `lincx://networks`, change its callback body to:

```ts
    async (uri, extra) => recorded("networks", extra, undefined, async () => {
      const r = await requireSession(extra);
      if ("error" in r) return plain(uri, r.error);
      return json(uri, { active_network: r.session.active_network, networks: r.session.networks ?? [] });
    }),
```

For the entity template loop, change its callback body to:

```ts
      async (uri, variables, extra) => recorded(`${seg}-by-id`, extra, variables, async () => {
        const r = await requireSession(extra);
        if ("error" in r) return plain(uri, r.error);
        const id = String(variables.id);
        try {
          const data = await workApiRequest<unknown>(r.session, "GET", `${basePath}/${id}`);
          return json(uri, data);
        } catch (err) {
          return plain(uri, handleWorkApiError(err));
        }
      }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/resources.test.ts`
Expected: PASS (existing 5 + new 1 = 6).

- [ ] **Step 5: Commit**

```bash
git add src/tools/resources.ts src/tests/resources.test.ts
git commit -m "feat(analytics): record resource reads (closes the resource blind spot)"
```

---

## Task 8: `/stats` endpoint

**Files:**
- Create: `src/routes/stats.ts`
- Test: `src/tests/stats.route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/stats.route.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";

// Set the token BEFORE importing constants/route (constants read env at load).
process.env.STATS_TOKEN = "secret-xyz";

const { buildTestApp } = await import("./helpers/testApp.js");
const { statsRouter } = await import("../routes/stats.js");

function app() {
  const a = buildTestApp();
  a.use(statsRouter);
  return a;
}

describe("GET /stats", () => {
  it("401s without the right bearer token", async () => {
    const res = await request(app()).get("/stats");
    expect(res.status).toBe(401);
  });

  it("returns the stats payload with the right token", async () => {
    const res = await request(app()).get("/stats").set("Authorization", "Bearer secret-xyz");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("window");
    expect(res.body).toHaveProperty("tools");
    expect(res.body).toHaveProperty("users");
    expect(res.body).toHaveProperty("errors");
    expect(res.body).toHaveProperty("sequences");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/stats.route.test.ts`
Expected: FAIL — cannot import `../routes/stats.js`.

- [ ] **Step 3: Implement the route**

Create `src/routes/stats.ts`:

```ts
/**
 * routes/stats.ts — GET /stats (in-house usage analytics).
 *
 * Gated by STATS_TOKEN (Authorization: Bearer <token>). If STATS_TOKEN is unset
 * the route 404s so it is never accidentally public. Safe to header-gate here:
 * unlike /mcp, /stats is not part of the OAuth discovery path.
 */
import { Router } from "express";
import { STATS_TOKEN, USAGE_EVENT_CAP } from "../constants.js";
import { getEventSink, computeStats } from "../services/usageAnalytics.js";

export const statsRouter: Router = Router();

statsRouter.get("/stats", async (req, res) => {
  if (!STATS_TOKEN) { res.status(404).end(); return; }
  if (req.header("authorization") !== `Bearer ${STATS_TOKEN}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, USAGE_EVENT_CAP) : USAGE_EVENT_CAP;
  try {
    const events = await (await getEventSink()).readRecent(limit);
    res.json(computeStats(events));
  } catch (err) {
    console.error("[Stats] read failed:", err instanceof Error ? err.message : String(err));
    res.json(computeStats([])); // degrade to empty, never 500
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/stats.route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/routes/stats.ts src/tests/stats.route.test.ts
git commit -m "feat(analytics): GET /stats endpoint (STATS_TOKEN-gated)"
```

---

## Task 9: Mount the route + document

**Files:**
- Modify: `src/index.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Mount the router**

In `src/index.ts`, add the import alongside the other route imports:

```ts
import { statsRouter } from "./routes/stats.js";
```

And mount it next to the other public routers (after `app.use("/oauth", oauthTokenRouter);`):

```ts
app.use(statsRouter);
```

- [ ] **Step 2: Document the analytics surface in CLAUDE.md**

Add this subsection under "## Implemented Tools" (or a new top-level "## Usage analytics" section) in `CLAUDE.md`:

```markdown
## Usage analytics

Every tool call and resource read is recorded as one `UsageEvent` in a capped
log (`services/usageAnalytics.ts`) — Redis list `usage:events` (cap
`USAGE_EVENT_CAP`, default 50k) or an in-memory ring buffer when `REDIS_URL` is
unset. Recording happens in `toolGuard` (tools) and `resources.ts` (reads),
fire-and-forget and failure-isolated — analytics can never delay or break a call.

`GET /stats` (gated by the `STATS_TOKEN` env via `Authorization: Bearer <token>`;
404 when unset) returns tool health, per-user adoption, error friction, and usage
sequences, computed on read by `computeStats`.

Privacy invariants: never store `auth_token`/OAuth tokens, never parameter VALUES
(keys only), never raw error messages (classified `error_kind` only). `user_id`/
`email` are stored for adoption analysis and only ever appear in the authenticated
`/stats` response — never in tool output.
```

- [ ] **Step 3: Build, run the full suite, and boot-smoke the endpoint**

```bash
npm run build && npm test
```
Expected: build exits 0; all tests pass.

```bash
STATS_TOKEN=secret REDIS_URL= PORT=5099 node dist/index.js &
sleep 2
curl -s -o /dev/null -w "no-auth=%{http_code} " http://localhost:5099/stats
curl -s -w "\nok=%{http_code}\n" -H "Authorization: Bearer secret" http://localhost:5099/stats
kill %1
```
Expected: `no-auth=401`, then `ok=200` with a JSON stats body.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts CLAUDE.md
git commit -m "feat(analytics): mount /stats route + document the analytics surface"
```

---

## Notes for the implementer

- **`_sink` is a module singleton.** Tests in Task 3–7 share the in-memory log across cases in a file; assertions use `.find(...)` rather than assuming exact length/position.
- **Fire-and-forget timing in tests.** After invoking a guarded handler / resource read, `await new Promise(r => setTimeout(r, 20))` before reading the sink, since `recordEvent` doesn't block the call.
- **No `console.log`** anywhere — `console.error` only (project rule).
- **Don't await `recordEvent`** in production code paths (toolGuard / resources). It returns `void` by design.
