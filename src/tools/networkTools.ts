/**
 * tools/networkTools.ts
 *
 * network_list    — list all accessible networks
 * network_switch  — change active network (Claude resolves name → id automatically)
 * network_refresh — re-fetch networks from Network Service
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { switchNetwork, refreshNetworks } from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";

export function registerNetworkTools(
  server: McpServer,
  getSessionId: () => string | null
): void {

  // ── network_list ──────────────────────────────────────────────────────────
  server.registerTool(
    "network_list",
    {
      title: "List Networks",
      description: `List all networks the current user has access to.

Use this before 'network_switch' to find the correct network_id.
Also use it when the user asks which network they are on.

Returns:
  {
    active_network_id: string | null,
    networks: Array<{ id: string, name: string, is_active: boolean }>
  }`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);
      if (!session) {
        return { content: [{ type: "text" as const, text: "Error: Session not found. Use 'auth_login' to re-authenticate." }] };
      }

      const result = {
        active_network_id: session.active_network,
        networks: session.networks.map((n) => ({
          id: n.id,
          name: n.name,
          is_active: n.id === session.active_network,
        })),
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // ── network_switch ────────────────────────────────────────────────────────
  server.registerTool(
    "network_switch",
    {
      title: "Switch Network",
      description: `Switch the active network for all subsequent API calls.

ALWAYS call 'network_list' first to get the correct network_id.

The session stays on the new network until switched again.

Args:
  - network_id (string): ID from 'network_list'

Returns: { success, active_network, previous_network_id, message }`,
      inputSchema: z.object({
        network_id: z.string().min(1).describe("Network ID from 'network_list'"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ network_id }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const result = await switchNetwork(sessionId, network_id);
      if (!result.success) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }] };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);
      const network = session?.networks.find((n) => n.id === network_id);

      const response = {
        success: true,
        active_network: { id: network_id, name: network?.name ?? network_id },
        previous_network_id: result.previousNetwork ?? null,
        message: `Switched to '${network?.name ?? network_id}'. All tool calls now use this network.`,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    }
  );

  // ── network_refresh ───────────────────────────────────────────────────────
  server.registerTool(
    "network_refresh",
    {
      title: "Refresh Networks",
      description: `Re-fetch the user's network list from the Network Service.

Use when a network seems to be missing or the user was recently added to a new one.
Preserves the active network if it still exists.`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const ok = await refreshNetworks(sessionId);
      if (!ok) {
        return { content: [{ type: "text" as const, text: "Error: Could not refresh networks. Session may be invalid." }] };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            networks: session?.networks ?? [],
            active_network: session?.active_network ?? null,
          }, null, 2),
        }],
      };
    }
  );
}
