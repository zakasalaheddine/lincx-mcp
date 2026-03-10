/**
 * tools/projectTools.ts
 *
 * Example business tools — swap these for your actual Work API endpoints.
 *
 * PATTERN TO FOLLOW FOR ALL BUSINESS TOOLS:
 *  1. Get sessionId from context
 *  2. Call validateSession() — handles existence, expiry, and network checks
 *  3. Use session.active_network implicitly via workApiRequest()
 *  4. NEVER accept network_id as a tool parameter
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";
import { ApiProject, PaginatedResponse } from "../types.js";

export function registerProjectTools(server: McpServer, getSessionId: () => string | null) {
  // ──────────────────────────────────────────
  // projects_list
  // ──────────────────────────────────────────
  server.registerTool(
    "projects_list",
    {
      title: "List Projects",
      description: `List projects in the currently active network.

The network context is derived automatically from your session — you do NOT
need to pass a network ID. To switch networks, use 'network_switch' first.

Args:
  - limit (number): Max results to return, 1–100 (default: 20)
  - offset (number): Pagination offset (default: 0)
  - status (string, optional): Filter by status — 'active' | 'archived' | 'draft'

Returns:
  {
    network_id: string,        // The network these results are from
    total: number,
    count: number,
    offset: number,
    has_more: boolean,
    next_offset?: number,
    projects: Array<{
      id: string,
      name: string,
      status: string,
      created_at: string
    }>
  }

Example:
  - "Show me projects" → projects_list()
  - "Show archived projects on Network B" → network_switch + projects_list({ status: "archived" })`,
      inputSchema: z
        .object({
          limit: z.number().int().min(1).max(100).default(20).describe("Max results to return"),
          offset: z.number().int().min(0).default(0).describe("Pagination offset"),
          status: z
            .enum(["active", "archived", "draft"])
            .optional()
            .describe("Filter projects by status"),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, offset, status }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const validation = await validateSession(sessionId);
      if (!validation.valid || !validation.session) {
        return { content: [{ type: "text" as const, text: `Error: ${validation.error ?? "Session invalid."}` }] };
      }

      const { session } = validation;

      try {
        const data = await workApiRequest<PaginatedResponse<ApiProject>>(
          session,
          "GET",
          "/v1/projects",
          {
            params: {
              limit,
              offset,
              ...(status ? { status } : {}),
            },
          }
        );

        const result = {
          network_id: session.active_network, // shows user which network they're on
          total: data.total,
          count: data.items.length,
          offset,
          has_more: data.has_more,
          ...(data.has_more ? { next_offset: offset + data.items.length } : {}),
          projects: data.items.map((p) => ({
            id: p.id,
            name: p.name,
            status: p.status,
            created_at: p.created_at,
          })),
        };

        const text = truncateIfNeeded(JSON.stringify(result, null, 2), data.total);

        return {
          content: [{ type: "text" as const, text }],
          structuredContent: result,
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
      }
    }
  );

  // ──────────────────────────────────────────
  // projects_get
  // ──────────────────────────────────────────
  server.registerTool(
    "projects_get",
    {
      title: "Get Project",
      description: `Get detailed information about a specific project by ID.

Network context is derived from your active session automatically.

Args:
  - project_id (string): The project ID to fetch

Returns full project details including metadata, status, and configuration.`,
      inputSchema: z
        .object({
          project_id: z.string().min(1).describe("The project ID to fetch"),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ project_id }) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
      }

      const validation = await validateSession(sessionId);
      if (!validation.valid || !validation.session) {
        return { content: [{ type: "text" as const, text: `Error: ${validation.error ?? "Session invalid."}` }] };
      }

      const { session } = validation;

      try {
        const project = await workApiRequest<ApiProject>(
          session,
          "GET",
          `/v1/projects/${project_id}`
        );

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
