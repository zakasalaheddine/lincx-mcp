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

import { REDIS_URL, USAGE_EVENT_CAP } from "../constants.js";
import { resolveLincxSession } from "./sessionManager.js";
import { getSessionStore } from "./sessionStore.js";

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

// ── EventSink ─────────────────────────────────────────────────────────────────

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

// ── recordEvent ───────────────────────────────────────────────────────────────

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

// ── computeStats ──────────────────────────────────────────────────────────────

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
