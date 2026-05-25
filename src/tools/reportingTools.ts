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
import { workApiRequest, handleWorkApiError, truncateIfNeeded, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";

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
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
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
      const text = JSON.stringify(data);
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
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── report_query ─────────────────────────────────────────────────────────────
  server.registerTool("report_query", {
    title: "Report Query",
    description: `Run a report against a dimension set and get SERVER-SIDE AGGREGATED metrics back — sums of zoneLoads, loads, impressions, clicks, actions, revenue, etc. The upstream API always returns hourly-granular rows (there is no "daily" mode); this tool rolls them up so the response stays small instead of dumping hundreds of rows.

- startDate and endDate are REQUIRED (YYYY-MM-DD).
- Omit groupBy for a single grand total over the whole range.
- Pass groupBy for breakdowns: ['zone'] = per-zone totals for the range; ['zone','date'] = per-zone per-day; ['advertiser'] = per-advertiser, etc.
- Only pass raw:true if you genuinely need every hourly row (large; may be truncated).`,
    inputSchema: z.object({
      dimensionSetId: z.string().describe("Dimension set ID to query"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Required. Start date, YYYY-MM-DD (e.g. 2026-05-18)"),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Required. End date, YYYY-MM-DD (e.g. 2026-05-25)"),
      groupBy: z.array(z.string()).optional().describe("Dimension fields to roll up by, e.g. ['zone'] or ['zone','date']. Omit for a grand total. Valid fields are the dimension set's dimensions (zone, template, advertiser, campaign, publisher, date, hour, …)."),
      raw: z.boolean().optional().default(false).describe("Return the raw, unaggregated hourly rows instead of rolled-up sums. Large — only when you specifically need per-hour detail."),
      testMode: z.boolean().optional().describe("Enable test mode (maps to query param 'test-mode')"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ dimensionSetId, startDate, endDate, groupBy, raw, testMode }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    // `date`/`hour` are time fields the API always emits; `level` is row metadata —
    // none of them are passed via `d`. Real dimensions in groupBy ARE, so the API
    // returns rows at that granularity and we sum across time.
    const TIME_OR_META = new Set(["date", "hour", "level"]);
    const cleanGroupBy = (groupBy ?? []).filter((g) => g !== "level");
    const apiDims = cleanGroupBy.filter((g) => !TIME_OR_META.has(g));

    try {
      const params: Record<string, unknown> = { startDate, endDate };
      if (apiDims.length) params.d = apiDims;
      if (testMode !== undefined) params["test-mode"] = testMode;

      // Reports can take >10s over a wide range — give them headroom.
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/reports/${dimensionSetId}`, { params, timeoutMs: 60_000 });
      const rows: Record<string, unknown>[] = Array.isArray(data) ? data : [];

      if (raw) {
        const text = `Report "${dimensionSetId}" | ${startDate}→${endDate} | raw rows: ${rows.length}\n\n${JSON.stringify(rows)}`;
        return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
      }

      const result = aggregateReport(rows, cleanGroupBy);
      return {
        content: [{
          type: "text" as const,
          text: truncateIfNeeded(JSON.stringify({
            dimensionSet: dimensionSetId,
            range: { startDate, endDate },
            groupBy: cleanGroupBy,
            rowsScanned: rows.length,
            ...result,
          })),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}

/** Money metrics rounded to cents; everything else (counts) kept as exact integers. */
const MONEY_FIELDS = new Set(["revenue", "revenuePublisher", "cost"]);
function roundMetric(key: string, n: number): number {
  return MONEY_FIELDS.has(key) ? Math.round(n * 100) / 100 : Math.round(n * 1e6) / 1e6;
}

/**
 * Roll up raw report rows server-side: sum every numeric field, grouped by the
 * `groupBy` field values. Returns a grand `total` always, plus a sorted `groups`
 * array when groupBy is non-empty. Keeps the response tiny vs. dumping raw rows.
 */
export function aggregateReport(
  rows: Record<string, unknown>[],
  groupBy: string[],
): { total: Record<string, number>; groups?: Record<string, unknown>[] } {
  const numericKeys = new Set<string>();
  for (const row of rows) {
    for (const [k, val] of Object.entries(row)) {
      if (typeof val === "number") numericKeys.add(k);
    }
  }

  const sumInto = (acc: Record<string, number>, row: Record<string, unknown>) => {
    for (const k of numericKeys) {
      const val = row[k];
      if (typeof val === "number") acc[k] = (acc[k] ?? 0) + val;
    }
  };
  const roundAll = (acc: Record<string, number>) => {
    for (const k of numericKeys) acc[k] = roundMetric(k, acc[k] ?? 0);
  };

  const total: Record<string, number> = {};
  for (const k of numericKeys) total[k] = 0;
  for (const row of rows) sumInto(total, row);

  if (groupBy.length === 0) {
    roundAll(total);
    return { total };
  }

  const groups = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = groupBy.map((g) => String(row[g] ?? "(n/a)")).join(" || ");
    let acc = groups.get(key);
    if (!acc) {
      acc = {};
      for (const g of groupBy) acc[g] = row[g] ?? "(n/a)";
      for (const k of numericKeys) acc[k] = 0;
      acc._rows = 0;
      groups.set(key, acc);
    }
    sumInto(acc as Record<string, number>, row);
    acc._rows = (acc._rows as number) + 1;
  }

  const sortKey = numericKeys.has("loads") ? "loads" : numericKeys.has("revenue") ? "revenue" : null;
  const groupRows = [...groups.values()];
  for (const g of groupRows) roundAll(g as Record<string, number>);
  roundAll(total);
  if (sortKey) {
    groupRows.sort((a, b) => ((b[sortKey] as number) ?? 0) - ((a[sortKey] as number) ?? 0));
  }

  return { total, groups: groupRows };
}
