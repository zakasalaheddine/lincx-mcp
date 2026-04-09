/**
 * services/networkService.ts
 *
 * Fetches the list of networks the authenticated user belongs to.
 * Uses the same Work API — no separate Network Service exists.
 *
 * Adjust NETWORKS_PATH if your endpoint differs.
 */

import { WORK_API_BASE_URL } from "../constants.js";
import type { Network } from "../types.js";

const NETWORKS_PATH = "/api/networks";

export async function fetchUserNetworks(authToken: string): Promise<Network[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(`${WORK_API_BASE_URL}${NETWORKS_PATH}`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.error("[Networks] Failed to fetch:", {
        url: `${WORK_API_BASE_URL}${NETWORKS_PATH}`,
        status: res.status,
      });
      return [];
    }

    const body = await res.json() as Record<string, unknown>;

    // Handle common response shapes: { networks: [] } | { data: [] } | { items: [] } | []
    const raw = (
      Array.isArray(body?.networks) ? body.networks :
      Array.isArray(body?.data)     ? body.data     :
      Array.isArray(body?.items)    ? body.items    :
      Array.isArray(body)           ? body           : []
    ) as Array<Record<string, unknown>>;

    return raw.map((n) => ({
      id: String(n.id),
      name: String(n.name ?? n.id),
      owner: String(n.owner ?? ""),
      members: Array.isArray(n.members) ? n.members as string[] : [],
      observers: Array.isArray(n.observers) ? n.observers as string[] : [],
      dateCreated: String(n.dateCreated ?? ""),
      dateUpdated: String(n.dateUpdated ?? ""),
      userUpdated: String(n.userUpdated ?? ""),
      customDimensions: Array.isArray(n.customDimensions)
        ? (n.customDimensions as Array<{ name: string; dateCreated: string }>)
        : [],
    }));
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      console.error("[Networks] Request timed out");
    } else {
      console.error("[Networks] Unexpected error:", err);
    }
    // Return empty list — login still succeeds, user can call network_refresh later
    return [];
  } finally {
    clearTimeout(timer);
  }
}
