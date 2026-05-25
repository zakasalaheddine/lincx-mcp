/**
 * tools/reportingTools.ts
 *
 * list_dimension_sets  — GET /api/dimension-sets
 * get_dimension_set    — GET /api/dimension-sets/{id}
 * get_event_stats_keys — GET /api/event-stats
 * report_query         — composite: GET /api/reports/{dimensionSetId}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, buildListEnvelope } from "../services/workApi.js";

export function registerReportingTools(server: McpServer): void {

  // ── list_dimension_sets ──────────────────────────────────────────────────────
  server.registerTool("list_dimension_sets", {
    title: "List Dimension Sets",
    description: `List all dimension sets available in the active network.`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(25),
      offset: z.number().int().min(0).default(0),
      fields: z.array(z.string()).optional().describe("Extra item fields to include beyond { id, name } plus status fields"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/dimension-sets", { params: { limit, offset } });
      const text = JSON.stringify(buildListEnvelope(data, { limit, offset, fields }), null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_dimension_set ────────────────────────────────────────────────────────
  server.registerTool("get_dimension_set", {
    title: "Get Dimension Set",
    description: `Fetch a single dimension set by ID. Used to inspect the metrics and dimensions available for a report_query call.`,
    inputSchema: z.object({
      id: z.string().describe("Dimension set ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/dimension-sets/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_event_stats_keys ─────────────────────────────────────────────────────
  server.registerTool("get_event_stats_keys", {
    title: "Get Event Stats Keys",
    description: `Fetch unique event key-value pairs collected by the active network over the last 31 days. Useful for understanding what filter keys are available when running report_query.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (_args, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/event-stats");
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── report_query ─────────────────────────────────────────────────────────────
  server.registerTool("report_query", {
    title: "Report Query",
    description: `Run a report query against a dimension set. Returns rows of metric data broken down by the specified dimensions. startDate and endDate are REQUIRED (the API rejects requests without them). Reports default to daily; pass resolution="hourly" for an hourly breakdown.`,
    inputSchema: z.object({
      dimensionSetId: z.string().describe("Dimension set ID to query"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Required. Start date, YYYY-MM-DD (e.g. 2026-05-18)"),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Required. End date, YYYY-MM-DD (e.g. 2026-05-25)"),
      resolution: z.literal("hourly").optional().describe("Omit for the daily default; pass 'hourly' for an hourly breakdown. ('day'/'hour' are NOT valid.)"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to break down by (repeated query param 'd', e.g. ['zone','template']). Omit to aggregate at the network level."),
      testMode: z.boolean().optional().describe("Enable test mode (maps to query param 'test-mode')"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ dimensionSetId, startDate, endDate, resolution, dimensions, testMode }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { startDate, endDate };
      if (resolution !== undefined) params.resolution = resolution;
      if (dimensions !== undefined) params.d = dimensions;
      if (testMode !== undefined) params["test-mode"] = testMode;

      // Reports can take >10s (esp. hourly over a wide range) — give them headroom.
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/reports/${dimensionSetId}`, { params, timeoutMs: 60_000 });

      const rowCount = Array.isArray(data) ? data.length : "?";
      const summary = `Report for dimension set "${dimensionSetId}" | Resolution: ${resolution ?? "default (daily)"} | Rows: ${rowCount}`;

      return { content: [{ type: "text" as const, text: truncateIfNeeded(`${summary}\n\n${JSON.stringify(data, null, 2)}`) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
