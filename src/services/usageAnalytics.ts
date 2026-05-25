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
