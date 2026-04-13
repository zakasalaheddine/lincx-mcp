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
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, stripListItems } from "../services/workApi.js";

export function registerReportingTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_dimension_sets ──────────────────────────────────────────────────────
  server.registerTool("list_dimension_sets", {
    title: "List Dimension Sets",
    description: `List all dimension sets available in the active network.`,
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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/dimension-sets", { params: { limit, offset } });
      const text = JSON.stringify(stripListItems(data), null, 2);
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
  }, async ({ id }) => {
    const sessionId = getSessionId();
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
  }, async () => {
    const sessionId = getSessionId();
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
    description: `Run a report query against a dimension set. Returns rows of metric data broken down by the specified dimensions and time resolution.`,
    inputSchema: z.object({
      dimensionSetId: z.string().describe("Dimension set ID to query"),
      startDate: z.string().optional().describe("Start date in ISO format (e.g. 2024-01-01)"),
      endDate: z.string().optional().describe("End date in ISO format (e.g. 2024-01-31)"),
      resolution: z.enum(["day", "hour"]).default("day").describe("Report resolution"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to break down by (maps to query param 'd')"),
      testMode: z.boolean().optional().describe("Enable test mode (maps to query param 'test-mode')"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ dimensionSetId, startDate, endDate, resolution, dimensions, testMode }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { resolution };
      if (startDate !== undefined) params.startDate = startDate;
      if (endDate !== undefined) params.endDate = endDate;
      if (dimensions !== undefined) params.d = dimensions;
      if (testMode !== undefined) params["test-mode"] = testMode;

      const data = await workApiRequest<unknown>(v.session, "GET", `/api/reports/${dimensionSetId}`, { params });

      const rowCount = Array.isArray(data) ? data.length : "?";
      const summary = `Report for dimension set "${dimensionSetId}" | Resolution: ${resolution} | Rows: ${rowCount}`;

      return { content: [{ type: "text" as const, text: truncateIfNeeded(`${summary}\n\n${JSON.stringify(data, null, 2)}`) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
