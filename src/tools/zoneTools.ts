/**
 * tools/zoneTools.ts
 *
 * list_zones          — GET /api/zones (paginated)
 * get_zone            — GET /api/zones/{id}
 * get_zone_report     — GET /api/zones/{id}/report
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape, includeShape, getEntityWithIncludes } from "./_shared.js";

export function registerZoneTools(server: McpServer): void {

  // ── list_zones ──────────────────────────────────────────────────────────────
  server.registerTool("list_zones", {
    title: "List Zones",
    description: `List all zones on the active network. Use get_zone to fetch full config of a specific zone.`,
    inputSchema: z.object({ ...paginationShape }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/zones", { params: { limit, offset } });
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
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
      ...includeShape,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await getEntityWithIncludes(v.session, "/api/zones", id, include);
      const text = JSON.stringify(data);
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
  }, async ({ id, resolution, startDate, endDate }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}/report`, { params: { resolution, startDate, endDate } });
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
