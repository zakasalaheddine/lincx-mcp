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
  mintTicket,
  unbindMcpSession,
} from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";
import { PUBLIC_BASE_URL, MCP_ACCESS_KEY } from "../constants.js";

function buildLoginUrl(ticket: string): string {
  const base = `${PUBLIC_BASE_URL}/login?t=${encodeURIComponent(ticket)}`;
  return MCP_ACCESS_KEY ? `${base}&key=${encodeURIComponent(MCP_ACCESS_KEY)}` : base;
}

export function registerAuthTools(server: McpServer): void {

  // ── auth_login ────────────────────────────────────────────────────────────
  server.registerTool(
    "auth_login",
    {
      title: "Login",
      description: `Open the browser login page to authenticate with Interlincx.

Returns a URL the user must open in their browser.
Credentials are entered there and sent directly to the identity server — Claude never sees them.

The URL is single-use and tied to this MCP session; it expires in 10 minutes.
After the user completes login, call 'auth_status' to confirm the session is active.

Returns: { login_url: string, message: string }`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const ticket = await mintTicket(extra?.sessionId);
      const url = buildLoginUrl(ticket);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            login_url: url,
            message: `Open ${url} in your browser, log in, then come back here and call 'auth_status'.`,
          }, null, 2),
        }],
      };
    }
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
  - available_networks: all networks accessible to the user

Use after 'auth_login' to confirm the session is ready.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
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

      const status = {
        authenticated: true,
        email: session.email,
        active_network: session.active_network,
        available_networks: session.networks,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
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
