/**
 * services/workApi.ts
 *
 * Authenticated HTTP client for the Work API.
 *
 * Multi-tenancy is handled via ?networkId=<id> on every request.
 * networkId is ALWAYS injected from session.active_network server-side —
 * Claude (the AI client) never passes it directly.
 *
 * Security contract:
 *   - Authorization header  → from session.auth_token   (never from client)
 *   - networkId query param → from session.active_network (never from client)
 */

import type { Session } from "../types.js";
import { WORK_API_BASE_URL, CHARACTER_LIMIT } from "../constants.js";

export async function workApiRequest<T>(
  session: Session,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; params?: Record<string, unknown>; timeoutMs?: number } = {}
): Promise<T> {
  const params = new URLSearchParams();
  // networkId always injected here — client tools never pass it
  params.set("networkId", session.active_network!);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      // Repeat the key per element (?d=zone&d=template) — OpenAPI form/explode,
      // which is what the Work API expects for array params like `d`.
      for (const item of v) {
        if (item !== undefined && item !== null) params.append(k, String(item));
      }
    } else {
      params.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  let res: Response;
  try {
    res = await fetch(`${WORK_API_BASE_URL}${path}?${params}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.auth_token}`,
        "Content-Type": "application/json",
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw Object.assign(new Error("Request timed out"), { code: "TIMEOUT" });
    }
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { code: "ECONNREFUSED" });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const httpError = Object.assign(new Error(`HTTP ${res.status}`), {
      status: res.status,
      data,
    });
    throw httpError;
  }

  return res.json() as Promise<T>;
}

/**
 * Render an upstream error body into a short, readable suffix so the actual
 * validation message reaches the caller instead of being swallowed. Returns ""
 * when there's nothing useful (empty object / null).
 */
function formatErrorBody(data: unknown): string {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data.trim() ? ` — ${data.trim()}` : "";
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Object.keys(obj).length === 0) return "";
    // Combine the headline (message/error) with the specific reason
    // (details/detail/errors) — the Work API puts the useful part in `details`,
    // e.g. { error: "Unprocessable Entity", details: "must have required property 'endDate'" }.
    const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
    const parts: string[] = [];
    const headline = obj.message ?? obj.error;
    const reason = obj.details ?? obj.detail ?? obj.errors;
    if (headline !== undefined) parts.push(asText(headline));
    if (reason !== undefined) parts.push(asText(reason));
    return parts.length ? ` — ${parts.join(": ")}` : ` — ${JSON.stringify(obj)}`;
  }
  return ` — ${String(data)}`;
}

export function handleWorkApiError(error: unknown): string {
  if (error instanceof Error) {
    const e = error as Error & { status?: number; data?: unknown; code?: string };
    if (e.status !== undefined) {
      const body = formatErrorBody(e.data);
      switch (e.status) {
        case 400: return `Error: Bad request${body}`;
        case 401: return "Error: Unauthorized. Use 'auth_logout' then 'auth_login' to re-authenticate.";
        case 403: return "Error: Forbidden — you don't have access to this resource on the active network.";
        case 404: return "Error: Resource not found. Double-check the ID.";
        case 422: return `Error: Unprocessable request (422 — the API rejected the parameters)${body}`;
        case 429: return "Error: Rate limit hit. Wait a moment then retry.";
        case 500: return "Error: Work API server error. Try again later.";
        default:  return `Error: API returned status ${e.status}${body}`;
      }
    }
    if (e.code === "TIMEOUT") return "Error: Request timed out.";
    if (e.code === "ECONNREFUSED") return "Error: Cannot reach Work API. Is it running?";
    return `Error: ${e.message}`;
  }
  return `Error: ${String(error)}`;
}

/**
 * Fields that are large content blobs — stripped from list responses to keep
 * token counts manageable. Full details are available via individual get_* tools.
 */
const HEAVY_FIELDS = new Set([
  "html", "css", "content", "schema", "fields", "config", "settings", "body", "template",
]);

function stripHeavyFields(item: unknown): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  return Object.fromEntries(
    Object.entries(item as Record<string, unknown>).filter(([key]) => !HEAVY_FIELDS.has(key))
  );
}

/**
 * Strip heavy content fields from list responses.
 * Handles bare arrays and objects that contain one array property (e.g. { templates: [...], total: N }).
 */
export function stripListItems(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(stripHeavyFields);
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        return { ...obj, [key]: (obj[key] as unknown[]).map(stripHeavyFields) };
      }
    }
  }
  return data;
}

/**
 * Standard envelope returned by every list_* tool.
 * Items are projected to a minimal field set to keep responses small.
 */
export interface ListEnvelope {
  items: unknown[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
}

// Status-ish fields worth surfacing in a list projection (at most 2 are kept).
const STATUS_FIELDS = ["status", "is_active", "active", "enabled", "state", "archived"];

function projectListItem(item: unknown, extraFields: string[]): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const obj = item as Record<string, unknown>;

  const keep: string[] = [];
  for (const base of ["id", "name"]) {
    if (base in obj) keep.push(base);
  }
  let statusAdded = 0;
  for (const s of STATUS_FIELDS) {
    if (statusAdded >= 2) break;
    if (s in obj) { keep.push(s); statusAdded++; }
  }
  for (const f of extraFields) {
    if (f in obj && !keep.includes(f)) keep.push(f);
  }

  const out: Record<string, unknown> = {};
  for (const k of keep) out[k] = obj[k];
  return out;
}

/**
 * Pull the items array and a total count (when the API provides one) out of an
 * unknown list response. Handles bare arrays and objects with one array property
 * (e.g. { items: [...], total: N } or { data: [...] }).
 */
function extractItemsAndTotal(data: unknown): { items: unknown[]; total: number | null } {
  if (Array.isArray(data)) return { items: data, total: null };
  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    let total: number | null = null;
    for (const k of ["total", "totalCount", "total_count", "count"]) {
      if (typeof obj[k] === "number") { total = obj[k] as number; break; }
    }
    for (const k of Object.keys(obj)) {
      if (Array.isArray(obj[k])) return { items: obj[k] as unknown[], total };
    }
  }
  return { items: [], total: null };
}

/**
 * Build the standard list envelope: minimal-field items plus pagination metadata.
 * When the upstream API reports a total it is used directly; otherwise total is a
 * lower bound (offset + page size) and has_more is inferred from a full page.
 */
export function buildListEnvelope(
  data: unknown,
  opts: { limit: number; offset: number; fields?: string[] }
): ListEnvelope {
  const { limit, offset, fields = [] } = opts;
  const { items, total } = extractItemsAndTotal(data);
  const projected = items.map((it) => projectListItem(it, fields));
  const hasMore = total !== null ? offset + items.length < total : items.length >= limit;
  return {
    items: projected,
    total: total ?? offset + items.length,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + items.length : null,
  };
}

/**
 * Serialize a list envelope to compact JSON, fitting it under CHARACTER_LIMIT by
 * DROPPING trailing items — never by slicing the string. This keeps the output
 * valid JSON (the old character-slice in truncateIfNeeded cut mid-structure and
 * produced unparseable responses) while keeping pagination metadata honest:
 * has_more/next_offset are rewritten so the caller can fetch the dropped items.
 */
export function listEnvelopeToText(env: ListEnvelope): string {
  if (JSON.stringify(env).length <= CHARACTER_LIMIT) return JSON.stringify(env);

  const fetched = env.items.length;
  const kept = [...env.items];
  // Reserve headroom for the larger truncated-envelope metadata.
  while (kept.length > 0) {
    const candidate = { ...env, items: kept, has_more: true };
    if (JSON.stringify(candidate).length <= CHARACTER_LIMIT - 200) break;
    kept.pop();
  }

  const next = env.offset + kept.length;
  const result = {
    ...env,
    items: kept,
    has_more: true,
    next_offset: next,
    truncated: {
      returned: kept.length,
      fetched,
      reason: `Response exceeded ${CHARACTER_LIMIT} chars. Returned ${kept.length} of ${fetched} fetched items; request offset=${next} to continue, or pass a narrower 'fields'.`,
    },
  };
  return JSON.stringify(result);
}

export function truncateIfNeeded(text: string, total?: number): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const suffix = total
    ? `\n\n[Truncated — ${total} total. Use 'limit'/'offset' to paginate.]`
    : "\n\n[Truncated. Use pagination parameters to see more.]";
  return text.slice(0, CHARACTER_LIMIT) + suffix;
}

/**
 * Serialize a single entity to valid JSON under CHARACTER_LIMIT.
 *
 * The old path (`truncateIfNeeded(JSON.stringify(entity))`) sliced the JSON
 * string mid-structure when an entity was too big (e.g. a template's html/css),
 * producing UNPARSEABLE output below the 30k tool-guard threshold. This instead
 * elides the largest STRING leaves one at a time, largest-first, until the result
 * fits — and ALWAYS emits valid JSON. A `_truncated` note lists the elided field
 * paths (e.g. `html`, `entity.css`) so the caller knows what was dropped and can
 * fetch full fidelity via the entity's resource URI (`lincx://{entity}/{id}`) or
 * a more specific tool (e.g. `get_template_version`).
 *
 * Invariant: `JSON.parse(fitEntityToText(x))` never throws, for any input.
 */
export function fitEntityToText(data: unknown): string {
  let text = JSON.stringify(data ?? null);
  if (text.length <= CHARACTER_LIMIT) return text;

  // Reserve headroom for the _truncated note appended after eliding.
  const budget = CHARACTER_LIMIT - 400;
  // Deep clone — data came from JSON (no cycles/functions), so this is safe.
  const clone: unknown = JSON.parse(text);

  type Leaf = { parent: Record<string, unknown> | unknown[]; key: string | number; path: string; length: number };
  const leaves: Leaf[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        const p = `${path}[${i}]`;
        if (typeof v === "string") leaves.push({ parent: node, key: i, path: p, length: v.length });
        else if (v && typeof v === "object") walk(v, p);
      });
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const p = path ? `${path}.${k}` : k;
        if (typeof v === "string") leaves.push({ parent: node as Record<string, unknown>, key: k, path: p, length: v.length });
        else if (v && typeof v === "object") walk(v, p);
      }
    }
  };
  walk(clone, "");
  leaves.sort((a, b) => b.length - a.length);

  // Elide the largest string leaf, re-measure, repeat — never over-elide in a batch.
  const elided: string[] = [];
  for (const leaf of leaves) {
    (leaf.parent as Record<string | number, unknown>)[leaf.key] = `[elided: ${leaf.length} chars]`;
    elided.push(leaf.path);
    text = JSON.stringify(clone);
    if (text.length <= budget) break;
  }

  const note = {
    elided,
    reason: `Response exceeded ${CHARACTER_LIMIT} chars; large string fields were elided. Fetch full content via the entity's resource URI (lincx://{entity}/{id}) or a more specific tool.`,
  };

  if (clone && typeof clone === "object" && !Array.isArray(clone)) {
    (clone as Record<string, unknown>)._truncated = note;
    text = JSON.stringify(clone);
    if (text.length <= CHARACTER_LIMIT) return text;
    // Eliding strings wasn't enough (huge non-string structure) — last-resort note.
    return JSON.stringify({ _truncated: { ...note, partial: true } });
  }
  // Array/primitive root — wrap so the note can ride along as valid JSON.
  const wrapped = JSON.stringify({ data: clone, _truncated: note });
  return wrapped.length <= CHARACTER_LIMIT ? wrapped : JSON.stringify({ _truncated: { ...note, partial: true } });
}
