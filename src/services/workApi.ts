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
  options: { body?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  const params = new URLSearchParams();
  // networkId always injected here — client tools never pass it
  params.set("networkId", session.active_network!);
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

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

export function handleWorkApiError(error: unknown): string {
  if (error instanceof Error) {
    const e = error as Error & { status?: number; data?: unknown; code?: string };
    if (e.status !== undefined) {
      switch (e.status) {
        case 400: return `Error: Bad request — ${JSON.stringify(e.data)}`;
        case 401: return "Error: Unauthorized. Use 'auth_logout' then 'auth_login' to re-authenticate.";
        case 403: return "Error: Forbidden — you don't have access to this resource on the active network.";
        case 404: return "Error: Resource not found. Double-check the ID.";
        case 429: return "Error: Rate limit hit. Wait a moment then retry.";
        case 500: return "Error: Work API server error. Try again later.";
        default:  return `Error: API returned status ${e.status}`;
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

export function truncateIfNeeded(text: string, total?: number): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const suffix = total
    ? `\n\n[Truncated — ${total} total. Use 'limit'/'offset' to paginate.]`
    : "\n\n[Truncated. Use pagination parameters to see more.]";
  return text.slice(0, CHARACTER_LIMIT) + suffix;
}
