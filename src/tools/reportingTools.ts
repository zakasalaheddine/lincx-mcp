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
import { RESPONSE_SIZE_LIMIT } from "../constants.js";
import { paginationShape } from "./_shared.js";

export function registerReportingTools(server: McpServer): void {

  // ── list_dimension_sets ──────────────────────────────────────────────────────
  server.registerTool("list_dimension_sets", {
    title: "List Dimension Sets",
    description: `List all dimension sets available in the active network.`,
    inputSchema: z.object({ ...paginationShape }).strict(),
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
- Pass filter to SCOPE the report to one entity, e.g. { advertiser: 'Acme' } or { zone: 'Primary' } — this is how you answer "how did offer X do" without pulling the whole network. The upstream report has no entity filter, so filtering is applied server-side over the fetched rows; match the value the dimension emits (usually its name). Each filter key must be a real dimension of this set.
- Only pass raw:true if you genuinely need every hourly row (large; may be truncated).`,
    inputSchema: z.object({
      dimensionSetId: z.string().describe("Dimension set ID to query"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Required. Start date, YYYY-MM-DD (e.g. 2026-05-18)"),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").describe("Required. End date, YYYY-MM-DD (e.g. 2026-05-25)"),
      groupBy: z.array(z.string()).optional().describe("Dimension fields to roll up by, e.g. ['zone'] or ['zone','date']. Omit for a grand total. Valid fields are the dimension set's dimensions (zone, template, advertiser, campaign, publisher, date, hour, …)."),
      filter: z.record(z.string(), z.string()).optional().describe("Scope to one entity: { dimension: value }, e.g. { advertiser: 'Acme' }. Matches the value the dimension emits (usually its name), case-insensitively. Each key must be a real dimension of this set — it's auto-added to the fetch so its column is present."),
      timezone: z.string().optional().describe("IANA timezone (e.g. 'America/Denver') to bucket date/hour in local time instead of UTC. Upstream is UTC-only; day boundaries shift, which matters — one Adnet advertiser's daily revenue moved 19% between UTC and Mountain. DST-correct. Omit for UTC."),
      raw: z.boolean().optional().default(false).describe("Return the raw, unaggregated hourly rows instead of rolled-up sums. Large — only when you specifically need per-hour detail."),
      testMode: z.boolean().optional().describe("Enable test mode (maps to query param 'test-mode')"),
    }).strict(),
    // structuredContent shape — covers both the aggregated default (total/groups)
    // and raw mode (raw rows). All mode-specific fields are optional so one schema
    // validates both returns.
    outputSchema: z.object({
      dimensionSet: z.string(),
      range: z.object({ startDate: z.string(), endDate: z.string() }),
      groupBy: z.array(z.string()),
      rowsScanned: z.number(),
      timezone: z.string().optional(),
      filter: z.record(z.string(), z.string()).optional(),
      rowsFetched: z.number().optional(),
      total: z.record(z.number()).optional(),
      groups: z.array(z.record(z.unknown())).optional(),
      raw: z.array(z.record(z.unknown())).optional(),
      rawTruncated: z.object({ returned: z.number(), total: z.number(), note: z.string() }).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ dimensionSetId, startDate, endDate, groupBy, filter, timezone, raw, testMode }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    if (timezone && !isValidTimeZone(timezone)) {
      return { content: [{ type: "text" as const, text: `Error: '${timezone}' is not a valid IANA timezone (e.g. 'America/Denver', 'UTC').` }] };
    }

    // `date`/`hour` are time fields the API always emits; `level` is row metadata —
    // none of them are passed via `d`. Real dimensions in groupBy ARE, so the API
    // returns rows at that granularity and we sum across time.
    const TIME_OR_META = new Set(["date", "hour", "level"]);
    const cleanGroupBy = (groupBy ?? []).filter((g) => g !== "level");
    // Filter keys must also be requested as dimensions, else their column is absent
    // from the rows and every row fails the match (would look like "no data").
    const filterKeys = filter ? Object.keys(filter) : [];
    const apiDims = [...new Set([...cleanGroupBy, ...filterKeys].filter((g) => !TIME_OR_META.has(g)))];

    try {
      // Upstream buckets strictly on UTC day boundaries. To bucket in a local tz we
      // fetch ONE UTC day of padding on each side, rebucket every hourly row's
      // date/hour into the tz, then trim back to the requested LOCAL range — else the
      // first/last local day is missing the UTC hours that fall outside the UTC window.
      const fetchStart = timezone ? shiftUtcDate(startDate, -1) : startDate;
      const fetchEnd = timezone ? shiftUtcDate(endDate, 1) : endDate;
      const params: Record<string, unknown> = { startDate: fetchStart, endDate: fetchEnd };
      if (apiDims.length) params.d = apiDims;
      if (testMode !== undefined) params["test-mode"] = testMode;

      // Reports can take >10s over a wide range — give them headroom.
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/reports/${dimensionSetId}`, { params, timeoutMs: 60_000 });
      let fetchedRows: Record<string, unknown>[] = Array.isArray(data) ? data : [];

      if (timezone) {
        // Rebucket UTC date/hour → local, then keep only rows inside the requested
        // local range (YYYY-MM-DD compares lexicographically).
        fetchedRows = rebucketRowsToTimezone(fetchedRows, timezone)
          .filter((r) => String(r.date) >= startDate && String(r.date) <= endDate);
      }

      // Server-side entity filter. Guard: if a filter key is present in NO fetched
      // row, it isn't a dimension of this set — error loudly rather than silently
      // returning zero (a wrong "no data" answer). If the key IS present but no row
      // matches the value, hint the values that DO exist so a typo is recoverable.
      const { rows, missingKeys, valueHints } = filterReportRows(fetchedRows, filter);
      if (missingKeys.length) {
        return { content: [{ type: "text" as const, text: `Error: filter key(s) [${missingKeys.join(", ")}] are not dimensions of this set. Call get_dimension_set to see valid dimensions, or use one in groupBy.` }] };
      }
      if (filter && fetchedRows.length > 0 && rows.length === 0) {
        const hint = valueHints.length ? ` Values present in range: ${valueHints.join(" | ")}.` : "";
        return { content: [{ type: "text" as const, text: `No rows matched filter ${JSON.stringify(filter)} over ${startDate}→${endDate}.${hint}` }] };
      }

      if (raw) {
        // outputSchema forces structuredContent, so the rows appear ~2.4× in the final
        // serialized result: once raw in structuredContent (1×) and once embedded as an
        // escaped JSON *string* in the content text (~1.4× from quote-escaping). Budget
        // for ~2.5× so the whole result stays under the tool-size guard — otherwise the
        // guard nukes the ENTIRE response. Aggregated mode (omit `raw`) is for wide ranges.
        const rowBudget = Math.floor((RESPONSE_SIZE_LIMIT - 2000) / 2.5);
        const kept: Record<string, unknown>[] = [];
        let used = 0;
        for (const row of rows) {
          used += JSON.stringify(row).length + 1;
          if (used > rowBudget && kept.length > 0) break;
          kept.push(row);
        }
        const capped = kept.length < rows.length;
        const structured = {
          dimensionSet: dimensionSetId,
          range: { startDate, endDate },
          groupBy: cleanGroupBy,
          rowsScanned: rows.length,
          ...(timezone ? { timezone } : {}),
          ...(filter ? { filter, rowsFetched: fetchedRows.length } : {}),
          raw: kept,
          ...(capped
            ? { rawTruncated: { returned: kept.length, total: rows.length, note: "Raw rows capped to fit the response size limit. Omit 'raw' for server-side aggregated totals, or narrow the date range." } }
            : {}),
        };
        const header = `Report "${dimensionSetId}" | ${startDate}→${endDate} | raw rows: ${kept.length}${capped ? ` of ${rows.length} (capped)` : ""}`;
        return {
          content: [{ type: "text" as const, text: `${header}\n\n${JSON.stringify(kept)}` }],
          structuredContent: structured,
        };
      }

      const structured = {
        dimensionSet: dimensionSetId,
        range: { startDate, endDate },
        groupBy: cleanGroupBy,
        rowsScanned: rows.length,
        ...(timezone ? { timezone } : {}),
        ...(filter ? { filter, rowsFetched: fetchedRows.length } : {}),
        ...aggregateReport(rows, cleanGroupBy),
      };
      return {
        content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(structured)) }],
        structuredContent: structured,
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}

/** True if `tz` is an IANA zone Intl accepts (throws RangeError otherwise). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Shift a YYYY-MM-DD date string by whole UTC days. */
export function shiftUtcDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/**
 * Rebucket each hourly report row from UTC into `tz`, replacing its `date`
 * (YYYY-MM-DD) and `hour` (00–23) with the local values. Uses Intl with the IANA
 * zone so DST transitions are handled correctly (a fixed offset would mis-bucket
 * on transition days). Rows without a usable date/hour pass through unchanged.
 */
export function rebucketRowsToTimezone(
  rows: Record<string, unknown>[],
  tz: string,
): Record<string, unknown>[] {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  return rows.map((row) => {
    const date = String(row.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return row;
    const [y, mo, d] = date.split("-").map(Number);
    const hh = Number(row.hour ?? 0);
    if (!Number.isFinite(hh)) return row;
    const parts = fmt.formatToParts(new Date(Date.UTC(y, mo - 1, d, hh)));
    const p: Record<string, string> = {};
    for (const part of parts) p[part.type] = part.value;
    // Intl emits "24" for midnight in some runtimes — normalize to "00".
    const localHour = p.hour === "24" ? "00" : p.hour;
    return { ...row, date: `${p.year}-${p.month}-${p.day}`, hour: localHour };
  });
}

/**
 * Server-side entity filter for report rows. The upstream /api/reports endpoint
 * has no entity filter (it's scoped only by the dimension set's networkId), so we
 * fetch and filter here — the filter dimensions are already requested via `d`.
 *
 * Returns:
 *  - rows:       rows matching every {key: value} (case-insensitive string match)
 *  - missingKeys: filter keys absent from EVERY fetched row → not a dimension of
 *                 this set. The caller errors on these instead of silently
 *                 returning zero rows (a wrong "no data" answer).
 *  - valueHints: when the key exists but nothing matched, the distinct values that
 *                DO appear for the filter keys (capped), so a typo is recoverable.
 */
export function filterReportRows(
  fetchedRows: Record<string, unknown>[],
  filter: Record<string, string> | undefined,
): { rows: Record<string, unknown>[]; missingKeys: string[]; valueHints: string[] } {
  if (!filter || Object.keys(filter).length === 0) {
    return { rows: fetchedRows, missingKeys: [], valueHints: [] };
  }
  const keys = Object.keys(filter);
  const present = new Set<string>();
  for (const row of fetchedRows) {
    for (const k of keys) if (k in row) present.add(k);
  }
  const missingKeys = fetchedRows.length > 0 ? keys.filter((k) => !present.has(k)) : [];
  if (missingKeys.length) return { rows: [], missingKeys, valueHints: [] };

  const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
  const rows = fetchedRows.filter((row) => keys.every((k) => norm(row[k]) === norm(filter[k])));

  let valueHints: string[] = [];
  if (rows.length === 0) {
    const seen = new Set<string>();
    for (const row of fetchedRows) {
      for (const k of keys) {
        const val = row[k];
        if (val !== undefined && val !== null) seen.add(`${k}=${String(val)}`);
      }
      if (seen.size >= 50) break;
    }
    valueHints = [...seen];
  }
  return { rows, missingKeys: [], valueHints };
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
