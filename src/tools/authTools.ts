/**
 * tools/authTools.ts
 *
 * auth_login  → tells Claude to direct user to the local login page
 * auth_status → reports session state
 * auth_logout → destroys session
 *
 * Credentials are NEVER passed through Claude.
 * Authentication happens entirely in the browser via the web UI.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { destroySession } from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";
import { SERVER_PORT } from "../constants.js";

export function registerAuthTools(
  server: McpServer,
  getSessionId: () => string | null,
  setSessionId: (id: string | null) => void
) {

  // ── auth_login ──────────────────────────────
  server.registerTool(
    "auth_login",
    {
      title: "Login",
      description: `Direct the user to authenticate via the browser login page.

Opens a local web UI where the user enters their Interlincx credentials directly.
Credentials are submitted directly to the identity server — they never pass through Claude.

After the user logs in successfully in the browser, call 'auth_status' to confirm
the session is active and see available networks.

Returns:
  - login_url: URL to open in the browser`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const loginUrl = `http://localhost:${SERVER_PORT}/login`;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            login_url: loginUrl,
            message: `Please open ${loginUrl} in your browser to log in. Once done, come back and I'll continue.`,
          }, null, 2),
        }],
      };
    }
  );

  // ── auth_status ─────────────────────────────
  server.registerTool(
    "auth_status",
    {
      title: "Auth Status",
      description: `Check whether the user is currently authenticated and view session details.

Returns:
  - authenticated (boolean)
  - email (string)
  - active_network: currently selected network
  - available_networks: all networks the user has access to

Use after 'auth_login' to confirm the session is ready before making API calls.`,
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
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              authenticated: false,
              message: `Not logged in. Use 'auth_login' — it will give you a URL to open in your browser.`,
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

  // ── auth_logout ─────────────────────────────
  server.registerTool(
    "auth_logout",
    {
      title: "Logout",
      description: `Log out the current user by destroying their session.

This clears all network context and the stored token from the session store.
The user will need to log in again via the browser to continue.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "No active session to log out from." }] };
      }
      await destroySession(sessionId);
      setSessionId(null);
      return { content: [{ type: "text" as const, text: "Logged out successfully. Session has been cleared." }] };
    }
  );
}
