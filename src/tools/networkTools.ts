/**
 * tools/networkTools.ts
 *
 * MCP tools for network context management:
 *  - network_list    → show user's available networks
 *  - network_switch  → change active network (by ID or name)
 *  - network_refresh → re-fetch networks from Network Service
 *
 * SECURITY: network_id is ALWAYS derived from session.
 * The AI client calls network_switch() — the server does the rest.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, switchNetwork, refreshNetworks } from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";

export function registerNetworkTools(server: McpServer, getSessionId: () => string | null) {
  // ──────────────────────────────────────────
  // network_list
  // ──────────────────────────────────────────
  server.registerTool(
    "network_list",
    {
      title: "List Networks",
      description: `List all networks the current user has access to.

Returns each network's ID and name, and indicates which one is currently active.

Use this tool when:
- User asks "what networks do I have access to?"
- You need to find a network ID before calling 'network_switch'
- User mentions a network by name and you need its ID

Returns:
  {
    active_network_id: string,
    networks: Array<{ id: string, name: string, is_active: boolean }>
  }`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }],
        };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);
      if (!session) {
        return {
          content: [{ type: "text" as const, text: "Error: Session not found. Use 'auth_login' to re-authenticate." }],
        };
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

  // ──────────────────────────────────────────
  // network_switch
  // ──────────────────────────────────────────
  server.registerTool(
    "network_switch",
    {
      title: "Switch Network",
      description: `Switch the active network context for subsequent API calls.

After switching, all business tool calls (projects_list, etc.) will operate
against the new network until switched again.

IMPORTANT: Always call 'network_list' first to get valid network IDs.

Args:
  - network_id (string): The ID of the network to switch to

Returns:
  {
    success: boolean,
    active_network: { id: string, name: string },
    previous_network_id: string | null,
    message: string
  }

Example flow:
  1. User: "check data on Network B"
  2. Call network_list() → find Network B id
  3. Call network_switch({ network_id: "network-b-id" })
  4. Call your business tools → they now run against Network B
  5. Optionally switch back with network_switch({ network_id: "network-a-id" })`,
      inputSchema: z.object({
        network_id: z
          .string()
          .min(1, "network_id is required")
          .describe("The ID of the network to activate — get this from 'network_list'"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ network_id }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }],
        };
      }

      const result = await switchNetwork(sessionId, network_id);

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
        };
      }

      // Fetch the network name for the confirmation message
      const store = await getSessionStore();
      const session = await store.get(sessionId);
      const network = session?.networks.find((n) => n.id === network_id);

      const response = {
        success: true,
        active_network: { id: network_id, name: network?.name ?? network_id },
        previous_network_id: result.previousNetwork ?? null,
        message: `Switched to network '${network?.name ?? network_id}'. All subsequent tool calls will use this network.`,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
        structuredContent: response,
      };
    }
  );

  // ──────────────────────────────────────────
  // network_refresh
  // ──────────────────────────────────────────
  server.registerTool(
    "network_refresh",
    {
      title: "Refresh Networks",
      description: `Re-fetch the user's network list from the Network Service.

Use this when:
- User says they were recently added to a new network
- A network seems to be missing from the list
- You get a network authorization error unexpectedly

This updates session.networks in place and preserves active_network if still valid.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return {
          content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }],
        };
      }

      const refreshed = await refreshNetworks(sessionId);

      if (!refreshed) {
        return {
          content: [{ type: "text" as const, text: "Error: Could not refresh networks. Session may be invalid." }],
        };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                networks: session?.networks ?? [],
                active_network: session?.active_network ?? null,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
