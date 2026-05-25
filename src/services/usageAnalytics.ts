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
