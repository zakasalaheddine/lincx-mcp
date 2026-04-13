/**
 * tools/publisherTools.ts
 *
 * list_publishers  — GET /api/publishers (paginated)
 * get_publisher    — GET /api/publishers/{id}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, stripListItems } from "../services/workApi.js";

export function registerPublisherTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_publishers ──────────────────────────────────────────────────────────
  server.registerTool("list_publishers", {
    title: "List Publishers",
    description: `List all publishers on the active network with limit/offset pagination.`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/publishers", { params: { limit, offset } });
      const text = JSON.stringify(stripListItems(data), null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_publisher ────────────────────────────────────────────────────────────
  server.registerTool("get_publisher", {
    title: "Get Publisher",
    description: `Fetch full configuration of a publisher by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Publisher ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/publishers/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
