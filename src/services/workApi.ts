/**
 * services/workApi.ts
 *
 * Authenticated HTTP client for the Work API.
 *
 * Security contract:
 *   - Authorization header is ALWAYS injected from session.auth_token
 *   - X-Network-ID is ALWAYS injected from session.active_network
 *   - Claude (the AI client) never passes either value directly
 */

import axios, { AxiosError } from "axios";
import type { Session } from "../types.js";
import { WORK_API_BASE_URL, CHARACTER_LIMIT } from "../constants.js";

export async function workApiRequest<T>(
  session: Session,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: { body?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  const res = await axios<T>({
    method,
    url: `${WORK_API_BASE_URL}${path}`,
    headers: {
      Authorization: `Bearer ${session.auth_token}`,
      "X-Network-ID": session.active_network!,
      "Content-Type": "application/json",
    },
    params: options.params,
    data: options.body,
    timeout: 10_000,
  });
  return res.data;
}

export function handleWorkApiError(error: unknown): string {
  if (error instanceof AxiosError && error.response) {
    switch (error.response.status) {
      case 400: return `Error: Bad request — ${JSON.stringify(error.response.data)}`;
      case 401: return "Error: Unauthorized. Use 'auth_logout' then 'auth_login' to re-authenticate.";
      case 403: return "Error: Forbidden — you don't have access to this resource on the active network.";
      case 404: return "Error: Resource not found. Double-check the ID.";
      case 429: return "Error: Rate limit hit. Wait a moment then retry.";
      case 500: return "Error: Work API server error. Try again later.";
      default:  return `Error: API returned status ${error.response.status}`;
    }
  }
  if (error instanceof AxiosError) {
    if (error.code === "ECONNABORTED") return "Error: Request timed out.";
    if (error.code === "ECONNREFUSED") return "Error: Cannot reach Work API.";
  }
  return `Error: ${error instanceof Error ? error.message : String(error)}`;
}

export function truncateIfNeeded(text: string, total?: number): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  const suffix = total
    ? `\n\n[Truncated — ${total} total. Use 'limit'/'offset' to paginate.]`
    : "\n\n[Truncated. Use pagination parameters to see more.]";
  return text.slice(0, CHARACTER_LIMIT) + suffix;
}
