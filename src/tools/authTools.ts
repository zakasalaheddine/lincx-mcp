/**
 * tools/authTools.ts
 *
 * auth_login  — returns a per-MCP-session browser login URL (with ticket).
 * auth_status — reports current session state.
 * auth_logout — unbinds this MCP session and destroys its Lincx session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  destroySession,
  resolveLincxSession,
  unbindMcpSession,
} from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";
import { selectNetworks } from "./networkTools.js";

export function registerAuthTools(server: McpServer): void {

  // ── auth_login ────────────────────────────────────────────────────────────
  server.registerTool(
    "auth_login",
    {
      title: "Login",
      description: `Authentication is now handled by your MCP client via OAuth.
If you are not yet signed in, your client should open a browser automatically.
Use 'auth_status' to check the current session.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => ({
      content: [{
        type: "text" as const,
        text: "Authentication is now handled by your MCP client via OAuth. " +
              "If you are not yet signed in, your client should open a browser " +
              "automatically. Use 'auth_status' to check the current session.",
      }],
    }),
  );

  // ── auth_status ───────────────────────────────────────────────────────────
  server.registerTool(
    "auth_status",
    {
      title: "Auth Status",
      description: `Check current authentication status and session details.

Returns:
  - authenticated (boolean)
  - email (string)
  - active_network: currently selected network ID
  - networks: accessible networks (active only by default, slimmed to
    { id, name, is_active, archived }) plus total / archived_hidden /
    next_offset paging fields

Pass includeArchived: true to include archived networks, limit/offset to page,
and verbose: true for full network objects. Defaults keep the response small on
high-network accounts.

Use after 'auth_login' to confirm the session is ready.`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe("Include archived networks. Default: active only."),
        limit: z.number().int().min(1).max(500).default(100).describe("Max networks to return"),
        offset: z.number().int().min(0).default(0).describe("Skip this many (page with next_offset)"),
        verbose: z.boolean().default(false).describe("Return full network objects instead of the slim fields"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const sessionId = await resolveLincxSession(extra?.sessionId);

      if (!sessionId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              authenticated: false,
              message: "Not logged in. Use 'auth_login' to get the browser login URL.",
            }),
          }],
        };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);

      if (!session) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              authenticated: false,
              message: "Session expired. Use 'auth_login' to re-authenticate.",
            }),
          }],
        };
      }

      const { active_network_id, ...netView } = selectNetworks(session, { includeArchived, limit, offset, verbose });
      const status = {
        authenticated: true,
        user: session.email,
        email: session.email,
        active_network: active_network_id,
        ...netView,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status) }],
        structuredContent: status,
      };
    }
  );

  // ── auth_logout ───────────────────────────────────────────────────────────
  server.registerTool(
    "auth_logout",
    {
      title: "Logout",
      description: `Destroy the current session and clear all auth context.

The user will need to log in again via the browser to continue.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const sessionId = await resolveLincxSession(extra?.sessionId);
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "No active session to log out from." }] };
      }
      await destroySession(sessionId);
      await unbindMcpSession(extra?.sessionId);
      return { content: [{ type: "text" as const, text: "Logged out. Session cleared." }] };
    }
  );
}
