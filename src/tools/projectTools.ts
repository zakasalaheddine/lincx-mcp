/**
 * tools/projectTools.ts
 *
 * Example business tools. Replace / extend with your actual Work API endpoints.
 *
 * Pattern every business tool must follow:
 *   1. Get sessionId from context — return error if missing
 *   2. Call validateSession() — handles missing session + network checks
 *   3. Call workApiRequest(session, ...) — auth + network injected automatically
 *   4. NEVER accept network_id as a parameter
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";
import type { ApiProject, PaginatedResponse } from "../types.js";

export function registerProjectTools(
  server: McpServer,
  getSessionId: () => string | null
): void {

  // ── projects_list ─────────────────────────────────────────────────────────
  server.registerTool(
    "projects_list",
    {
      title: "List Projects",
      description: `List projects in the currently active network.

Network context is derived automatically from your session.
To query a different network, call 'network_switch' first.

Args:
  - limit  (number, 1–100, default 20): max results
  - offset (number, default 0): pagination offset
  - status (optional): 'active' | 'archived' | 'draft'

Returns:
  { network_id, total, count, offset, has_more, next_offset?, projects[] }`,
      inputSchema: z.object({
        limit:  z.number().int().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        status: z.enum(["active", "archived", "draft"]).optional().describe("Filter by status"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ limit, offset, status }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const v = await validateSession(sessionId);
      if (!v.valid || !v.session) {
        return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
      }

      try {
        const data = await workApiRequest<PaginatedResponse<ApiProject>>(
          v.session, "GET", "/v1/projects",
          { params: { limit, offset, ...(status ? { status } : {}) } }
        );

        const result = {
          network_id: v.session.active_network,
          total: data.total,
          count: data.items.length,
          offset,
          has_more: data.has_more,
          ...(data.has_more ? { next_offset: offset + data.items.length } : {}),
          projects: data.items.map((p) => ({
            id: p.id, name: p.name, status: p.status, created_at: p.created_at,
          })),
        };

        return {
          content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(result, null, 2), data.total) }],
          structuredContent: result,
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
      }
    }
  );

  // ── projects_get ──────────────────────────────────────────────────────────
  server.registerTool(
    "projects_get",
    {
      title: "Get Project",
      description: `Get details for a specific project by ID.

Network context is derived from your active session automatically.

Args:
  - project_id (string): the project ID to fetch`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Project ID"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const v = await validateSession(sessionId);
      if (!v.valid || !v.session) {
        return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
      }

      try {
        const project = await workApiRequest<ApiProject>(v.session, "GET", `/v1/projects/${project_id}`);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(project, null, 2) }],
          structuredContent: project as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
      }
    }
  );
}
