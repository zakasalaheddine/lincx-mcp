/**
 * services/networkService.ts
 *
 * Fetches the list of networks the authenticated user belongs to.
 * Uses the same Work API — no separate Network Service exists.
 *
 * Adjust NETWORKS_PATH if your endpoint differs.
 */

import axios, { AxiosError } from "axios";
import { WORK_API_BASE_URL } from "../constants.js";
import type { Network } from "../types.js";

const NETWORKS_PATH = "/api/networks";

export async function fetchUserNetworks(authToken: string): Promise<Network[]> {
  console.log(`${WORK_API_BASE_URL}${NETWORKS_PATH}`)
  try {
    const res = await axios.get<unknown>(
      `${WORK_API_BASE_URL}${NETWORKS_PATH}`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 10_000,
      }
    );

    // Handle common response shapes: { networks: [] } | { data: [] } | []
    const body = res.data as Record<string, unknown>;
    const raw = (
      Array.isArray(body?.networks) ? body.networks :
      Array.isArray(body?.data)     ? body.data     :
      Array.isArray(body?.items)    ? body.items    :
      Array.isArray(body)           ? body           : []
    ) as Array<{ id: string; name?: string }>;

    return raw.map((n) => ({ id: String(n.id), name: String(n.name ?? n.id) }));
  } catch (err) {
    if (err instanceof AxiosError) {
      console.error("[Networks] Failed to fetch:", {
        url: `${WORK_API_BASE_URL}${NETWORKS_PATH}`,
        status: err.response?.status,
        data: JSON.stringify(err.response?.data),
        code: err.code,
      });
    } else {
      console.error("[Networks] Unexpected error:", err);
    }
    // Return empty list — login still succeeds, user can call network_refresh later
    return [];
  }
}
