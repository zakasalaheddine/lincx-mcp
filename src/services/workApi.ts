/**
 * services/workApi.ts
 *
 * Authenticated HTTP client for the Work API.
 *
 * SECURITY CONTRACT:
 *  - access_token injected server-side (never from client)
 *  - X-Network-ID injected from session.active_network (never from client)
 *  - Client tools call business functions — they never pass auth headers or network IDs
 */

import axios, { AxiosError } from "axios";
import { Session } from "../types.js";
import { WORK_API_BASE_URL, CHARACTER_LIMIT } from "../constants.js";

// ─────────────────────────────────────────────
// CORE REQUEST FUNCTION
// ─────────────────────────────────────────────

export async function workApiRequest<T>(
  session: Session,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  options: {
    body?: unknown;
    params?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const response = await axios<T>({
    method,
    url: `${WORK_API_BASE_URL}${path}`,
    headers: {
      // These headers are ALWAYS set server-side — client never controls them
      Authorization: `Bearer ${session.auth_token}`,
      "X-Network-ID": session.active_network!,
      "Content-Type": "application/json",
    },
    params: options.params,
    data: options.body,
    timeout: 10_000,
  });

  return response.data;
}

// ─────────────────────────────────────────────
// ERROR HANDLER — actionable messages for Claude
// ─────────────────────────────────────────────

export function handleWorkApiError(error: unknown): string {
  if (error instanceof AxiosError) {
    if (error.response) {
      switch (error.response.status) {
        case 400:
          return `Error: Invalid request — ${JSON.stringify(error.response.data)}`;
        case 401:
          return "Error: Unauthorized. Your session may have expired. Please use 'auth_logout' then 'auth_login' to re-authenticate.";
        case 403:
          return "Error: You don't have permission to access this resource on the current network.";
        case 404:
          return "Error: Resource not found. Please check the ID is correct.";
        case 429:
          return "Error: Rate limit exceeded. Please wait a moment before retrying.";
        case 500:
          return "Error: Work API server error. Please try again later.";
        default:
          return `Error: API request failed with status ${error.response.status}`;
      }
    } else if (error.code === "ECONNABORTED") {
      return "Error: Request timed out. Please try again.";
    } else if (error.code === "ECONNREFUSED") {
      return "Error: Cannot reach Work API. Check your network connection.";
    }
  }

  return `Error: Unexpected error — ${error instanceof Error ? error.message : String(error)}`;
}

// ─────────────────────────────────────────────
// RESPONSE TRUNCATION GUARD
// ─────────────────────────────────────────────

export function truncateIfNeeded(text: string, itemCount?: number): string {
  if (text.length <= CHARACTER_LIMIT) return text;

  const truncated = text.slice(0, CHARACTER_LIMIT);
  const suffix = itemCount
    ? `\n\n[Response truncated — ${itemCount} items total. Use 'limit' and 'offset' parameters to paginate.]`
    : `\n\n[Response truncated. Use pagination parameters to see more.]`;

  return truncated + suffix;
}
