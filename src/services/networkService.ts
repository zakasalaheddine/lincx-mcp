/**
 * services/networkService.ts
 *
 * Fetches the user's networks from the Network Service API.
 * Replace NETWORKS_ENDPOINT path if your API uses a different route.
 */

import axios, { AxiosError } from "axios";
import { NETWORK_API_BASE_URL } from "../constants.js";

// Adjust this path if your Network Service API uses a different endpoint
const NETWORKS_ENDPOINT = "/v1/networks";

export interface Network {
  id: string;
  name: string;
}

export async function fetchUserNetworks(authToken: string): Promise<Network[]> {
  try {
    const res = await axios.get<{ networks?: Array<{ id: string; name: string }>; data?: Array<{ id: string; name: string }> }>(
      `${NETWORK_API_BASE_URL}${NETWORKS_ENDPOINT}`,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );

    const raw = res.data?.networks ?? res.data?.data ?? res.data;
    if (Array.isArray(raw)) {
      return raw.map((n) => ({ id: String(n.id), name: String(n.name ?? n.id) }));
    }
    if (typeof raw === "object" && raw !== null && "items" in raw) {
      const items = (raw as { items: Array<{ id: string; name?: string }> }).items;
      return Array.isArray(items) ? items.map((n) => ({ id: String(n.id), name: String(n.name ?? n.id) })) : [];
    }
    return [];
  } catch (err) {
    if (err instanceof AxiosError) {
      if (err.response?.status === 401) {
        throw new Error("Unauthorized. Token may be invalid or expired.");
      }
      if (err.response?.status === 403) {
        throw new Error("Forbidden. You do not have access to list networks.");
      }
      const msg = err.response?.data?.message ?? err.message;
      throw new Error(msg ?? "Failed to fetch networks");
    }
    throw err;
  }
}
