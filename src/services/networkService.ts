/**
 * services/networkService.ts
 *
 * Fetches the list of networks the authenticated user belongs to.
 * Called once at session creation; call refreshNetworks() to re-fetch.
 *
 * Adjust NETWORKS_PATH if your API uses a different endpoint.
 */

import axios, { AxiosError } from "axios";
import { NETWORK_API_BASE_URL } from "../constants.js";
import type { Network } from "../types.js";

const NETWORKS_PATH = "/v1/networks";

export async function fetchUserNetworks(authToken: string): Promise<Network[]> {
  try {
    const res = await axios.get<unknown>(
      `${NETWORK_API_BASE_URL}${NETWORKS_PATH}`,
      {
        headers: { Authorization: `Bearer ${authToken}` },
        timeout: 10_000,
      }
    );

    // Handle common response shapes: { networks: [] } | { data: [] } | []
    const body = res.data as Record<string, unknown>;
    const raw =
      (Array.isArray(body?.networks) ? body.networks :
       Array.isArray(body?.data)     ? body.data     :
       Array.isArray(body?.items)    ? body.items    :
       Array.isArray(body)           ? body           : []) as Array<{ id: string; name?: string }>;

    return raw.map((n) => ({ id: String(n.id), name: String(n.name ?? n.id) }));
  } catch (err) {
    if (err instanceof AxiosError) {
      if (err.response?.status === 401) throw new Error("Unauthorized — token may be invalid");
      if (err.response?.status === 403) throw new Error("Forbidden — no access to list networks");
      const msg = (err.response?.data as { message?: string })?.message ?? err.message;
      throw new Error(msg);
    }
    throw err;
  }
}
