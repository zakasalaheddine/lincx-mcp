/**
 * tools/zoneTools.ts
 *
 * list_zones          — GET /api/zones (paginated)
 * get_zone            — GET /api/zones/{id}
 * get_zone_parents    — GET /api/zones/{id}/parents
 * get_zone_report     — GET /api/zones/{id}/report
 * zone_load_trace     — composite: fan-out diagnostic (added in Task 5)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerZoneTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_zones ──────────────────────────────────────────────────────────────
  server.registerTool("list_zones", {
    title: "List Zones",
    description: `List all zones on the active network. Use get_zone to fetch full config of a specific zone.`,
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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/zones", { params: { limit, offset } });
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone ────────────────────────────────────────────────────────────────
  server.registerTool("get_zone", {
    title: "Get Zone",
    description: `Fetch full configuration of a zone by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone_parents ────────────────────────────────────────────────────────
  server.registerTool("get_zone_parents", {
    title: "Get Zone Parents",
    description: `Fetch the parent hierarchy of a zone: site → channel → publisher → network.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}/parents`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone_report ─────────────────────────────────────────────────────────
  server.registerTool("get_zone_report", {
    title: "Get Zone Report",
    description: `Fetch timeseries report data for a zone.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
      resolution: z.enum(["day", "hour"]).default("day"),
      startDate: z.string().describe("ISO date e.g. 2026-01-01"),
      endDate: z.string().describe("ISO date e.g. 2026-01-31"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, resolution, startDate, endDate }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}/report`, { params: { resolution, startDate, endDate } });
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
