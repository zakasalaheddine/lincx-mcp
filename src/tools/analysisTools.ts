/**
 * tools/analysisTools.ts
 *
 * create_analysis — POST /api/analysis
 * get_analysis    — GET  /api/analysis/{id}
 * list_analyses   — GET  /api/analysis
 *
 * Zone tier analysis. The Work API runs a deterministic engine (aggregation,
 * reliability-weighted CPM, waterfall rank collapse, percentile tier banding)
 * and optionally a Gemini pass that only writes narrative on top of it.
 *
 * These tools default to `noLLM: true` — the engine result comes back with the
 * narrative fields empty and the CALLING agent writes them. That is the whole
 * point: no second LLM bill, and the analysis prompt lives in a skill where it
 * can be iterated, not baked into this server.
 *
 * Each tool is one Work API call. Polling is the caller's job (create returns a
 * QUEUED job; get reports status) — no orchestration here, per the server scope
 * rule in CLAUDE.md.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError } from "../services/workApi.js";
import { RESPONSE_SIZE_LIMIT } from "../constants.js";
import { READONLY_ANNOTATIONS } from "./_shared.js";

const ZONE_ID_RE = /^[a-z0-9]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const ANALYSIS_TYPES = ["offerTiering", "rankedOfferOptimization"] as const;
const ANALYSIS_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

/** Fields returned by list_analyses. Keeps a 100-row page well under the guard. */
const LIST_FIELDS = [
  "_id",
  "status",
  "analysisType",
  "name",
  "networkId",
  "request",
  "userCreated",
  "dateCreated",
  "dateCompleted",
  "error",
].join(",");

type AnalysisDoc = Record<string, unknown> & { _id?: string; status?: string };

/**
 * Sections dropped unconditionally — never useful to the model, always big.
 *
 * `output.rawResponse` is the provider's raw text (a duplicate of output.json);
 * `input.prompt` is the rendered Gemini prompt, which is absent on noLLM runs
 * anyway and is exactly the thing a skill replaces.
 */
const ALWAYS_DROP: string[][] = [
  ["output", "rawResponse"],
  ["input", "prompt"],
];

/**
 * Shed order when the doc still exceeds the response guard, cheapest loss first.
 *
 *   1. rankDistribution — creatives x ranks, by far the biggest array
 *   2. zoneMetrics      — per-day zone rows; the health verdict survives in output
 *   3. the ranked-optimization input context — duplicated wholesale into
 *      output.json by finalize-output, so dropping it loses nothing
 *   4. the non-monetizing / default-tier diagnostic lists
 *   5. localTiers — the peer comparison that carries the narrative, so last
 */
const SHED_ORDER: string[][] = [
  ["input", "tieringContext", "rankDistribution"],
  ["input", "zoneMetrics"],
  ["input", "rankedOfferOptimizationContext"],
  ["input", "tieringContext", "nonMonetizingCreatives"],
  ["input", "tieringContext", "defaultTierCreatives"],
  ["input", "tieringContext", "localTiers"],
];

function deletePath(doc: AnalysisDoc, path: string[]): boolean {
  let node: Record<string, unknown> = doc;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) return false;
    node = next as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (!(last in node)) return false;
  delete node[last];
  return true;
}

function header(doc: AnalysisDoc): string {
  const request = (doc.request ?? {}) as Record<string, unknown>;
  const range = request.dateStart && request.dateEnd ? ` ${request.dateStart}..${request.dateEnd}` : "";
  const zone = request.zoneId ? ` zone ${request.zoneId}` : "";
  return `analysis ${doc._id ?? "?"} · ${doc.analysisType ?? "?"} · ${doc.status ?? "?"}${zone}${range}`;
}

/**
 * Serialize one analysis doc to `header\n\ncompact JSON`, under `limit`.
 *
 * Text content, not structuredContent — MCP hosts feed only `content` to the
 * model (same reason as get_zone_targeting_inventory).
 *
 * Invariant: the JSON after the first blank line always parses, and the tier
 * assignments in `output.json` are never shed — a partial answer here would be
 * an answer the model silently completes with invented rows.
 */
export function fitAnalysis(doc: AnalysisDoc, limit: number): { content: { type: "text"; text: string }[] } {
  // Cheap deep clone — the doc came off the wire as JSON.
  const trimmed: AnalysisDoc = JSON.parse(JSON.stringify(doc ?? {}));
  const omitted: string[] = [];

  for (const path of ALWAYS_DROP) deletePath(trimmed, path);

  const status = String(trimmed.status ?? "").toLowerCase();
  if (status === "queued" || status === "running") {
    trimmed.note = "Job is not finished. Poll get_analysis again; do not report on a partial document.";
  }

  const wrap = (d: AnalysisDoc) => ({
    content: [{ type: "text" as const, text: `${header(d)}\n\n${JSON.stringify(d)}` }],
  });
  const size = (d: AnalysisDoc) => header(d).length + 2 + JSON.stringify(d).length;

  if (size(trimmed) <= limit) return wrap(trimmed);

  for (const path of SHED_ORDER) {
    if (deletePath(trimmed, path)) {
      omitted.push(path.join("."));
      trimmed.omitted = omitted;
      if (size(trimmed) <= limit) return wrap(trimmed);
    }
  }

  // Last resort: the engine verdict plus provenance, explicitly flagged partial.
  const minimal: AnalysisDoc = {
    _id: trimmed._id,
    status: trimmed.status,
    analysisType: trimmed.analysisType,
    networkId: trimmed.networkId,
    request: trimmed.request,
    error: trimmed.error,
    output: trimmed.output,
    complete: false,
    omitted: [...omitted, "input"],
    note: "Input context omitted — the document exceeded the response limit. output.json is complete; re-run over a shorter date range for the input breakdown.",
  };
  if (size(minimal) <= limit) return wrap(minimal);

  // `output.json` alone busts the budget (a wide zone's tier tables can). Drop it
  // too rather than string-slicing the JSON: a sliced payload is unparseable, and
  // half a tier table is one the model finishes from imagination.
  return wrap({
    _id: trimmed._id,
    status: trimmed.status,
    analysisType: trimmed.analysisType,
    networkId: trimmed.networkId,
    request: trimmed.request,
    error: trimmed.error,
    complete: false,
    omitted: [...omitted, "input", "output"],
    note: "Result exceeded the response limit even after shedding every input section. Re-run over a shorter date range, or read this analysis by id from the Work API directly.",
  });
}

export function registerAnalysisTools(server: McpServer): void {

  // ── create_analysis ─────────────────────────────────────────────────────────
  server.registerTool("create_analysis", {
    title: "Create Zone Tier Analysis",
    description: `Queue a zone tier analysis job and return the QUEUED document (its _id is what you poll with). Asynchronous — the job is NOT finished when this returns; call get_analysis until status is 'succeeded' or 'failed'.

analysisType 'offerTiering' groups a zone's creatives into performance tiers (TIER_1 / TIER_2A / TIER_2B / TIER_3) from reliability-weighted CPM, revenue share and CTR. 'rankedOfferOptimization' answers the adjacent question — which creative belongs in which rank slot — by banding waterfall winners on CPM proximity into premium/standard/starter config groups.

noLLM defaults to TRUE: the deterministic engine runs and the narrative fields (tier_rationale, per-row justification, confidence, improvement_guidance, next_actions) come back EMPTY BY DESIGN for you to write. Set it false only to also get the server-side Gemini narrative.

Access is restricted to an allowlist of Lincx emails; a 403 means the logged-in user is not on it. Requires access to the zone's network.`,
    inputSchema: z.object({
      zoneId: z.string().regex(ZONE_ID_RE, "zoneId must be 6 lowercase letters or digits").describe("Zone to analyze"),
      dateStart: z.string().regex(DATE_RE, "dateStart must be YYYY-MM-DD").describe("Start date, YYYY-MM-DD, inclusive"),
      dateEnd: z.string().regex(DATE_RE, "dateEnd must be YYYY-MM-DD").describe("End date, YYYY-MM-DD, inclusive"),
      analysisType: z.enum(ANALYSIS_TYPES).default("offerTiering").describe("offerTiering (creative tiers) or rankedOfferOptimization (rank slot assignment)"),
      timezone: z.string().default("UTC").describe("Timezone CODE (e.g. UTC, EST, PDT) — not an IANA name. Buckets days and interprets the date range."),
      noLLM: z.boolean().default(true).describe("True (default): deterministic engine only, narrative fields empty for you to write. False: also run the server-side Gemini narrative."),
      name: z.string().max(100).optional().describe("Optional label for the job"),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ zoneId, dateStart, dateEnd, analysisType, timezone, noLLM, name }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const body: Record<string, unknown> = { zoneId, dateStart, dateEnd, analysisType, timezone, noLLM };
      if (name !== undefined) body.name = name;
      const doc = await workApiRequest<AnalysisDoc>(v.session, "POST", "/api/analysis", { body });

      // The API derives networkId from the ZONE, ignoring the injected query
      // param — but list_analyses filters BY that param. Cross-network creates
      // therefore succeed and then never show up in the list.
      const active = v.session.active_network;
      if (doc?.networkId && active && doc.networkId !== active) {
        doc.note = `Created on network ${doc.networkId} (the zone's), not the active network ${active}. Poll get_analysis by _id — list_analyses will not show it until you network_switch.`;
      }
      return fitAnalysis(doc, RESPONSE_SIZE_LIMIT);
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_analysis ────────────────────────────────────────────────────────────
  server.registerTool("get_analysis", {
    title: "Get Zone Tier Analysis",
    description: `Fetch one analysis job by ID. Poll this after create_analysis until status is 'succeeded' or 'failed' ('queued'/'running' documents carry no results and say so in a note).

Returns a one-line header, a blank line, then compact JSON — parse everything after the first blank line. On success the payload is:
- output.json — the engine verdict: structural_context, tier_grouping, tier_tables (TIER_1/TIER_2A/TIER_2B/TIER_3 rows with rank, ids, ctr, cpm, revenue, impressions, days_at_rank, localTier), risk_flags. On a noLLM run its narrative fields (tier_rationale, justification, confidence, improvement_guidance, next_actions) are EMPTY BY DESIGN.
- input.tieringContext — the scoring detail behind it: per-creative tierScore, revenueShare, isStable, assignedTier, assignedRank, slot metrics, localTiers + diagnostics, rankDistribution, riskFlags, datasetConfidence.
- input.zoneMetrics / input.dataQuality / input.warnings — daily zone rows and row-quality counts.
- execution — provider, model, token usage and cost (zeroed on noLLM runs).

Tier assignments are PRECOMPUTED. Do not re-cluster or re-rank them from the raw metrics. Oversized documents shed input sections (listed in an 'omitted' array), never the output verdict.`,
    inputSchema: z.object({
      id: z.string().describe("Analysis job ID, as returned by create_analysis"),
    }).strict(),
    annotations: READONLY_ANNOTATIONS,
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const doc = await workApiRequest<AnalysisDoc>(v.session, "GET", `/api/analysis/${id}`);
      return fitAnalysis(doc, RESPONSE_SIZE_LIMIT);
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── list_analyses ───────────────────────────────────────────────────────────
  server.registerTool("list_analyses", {
    title: "List Zone Tier Analyses",
    description: `List analysis jobs on the active network, newest first. Summary fields only (id, status, type, name, request, dates, error) — use get_analysis for results.

Pages by cursor, not offset: pass the '_id' of the last row you received as 'cursor' to get the next page. A 'next_cursor' is returned when a full page came back.`,
    inputSchema: z.object({
      status: z.enum(ANALYSIS_STATUSES).optional().describe("Only jobs in this status"),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional().describe("The _id of the last row of the previous page"),
    }).strict(),
    annotations: READONLY_ANNOTATIONS,
  }, async ({ status, limit, cursor }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { limit, fields: LIST_FIELDS };
      if (status !== undefined) params.status = status;
      if (cursor !== undefined) params.cursor = cursor;
      const res = await workApiRequest<{ data?: AnalysisDoc[] }>(v.session, "GET", "/api/analysis", { params });

      const data = Array.isArray(res?.data) ? res.data : [];

      // Drop whole rows, never slice the JSON — and recompute next_cursor from the
      // LAST KEPT row. Cursor paging is `_id < cursor`, so a cursor taken from a
      // row that was then dropped skips those jobs permanently.
      let kept = data;
      const envelope = (): Record<string, unknown> => {
        const e: Record<string, unknown> = { count: kept.length, data: kept };
        if (data.length === limit) e.next_cursor = kept[kept.length - 1]?._id;
        if (kept.length < data.length) {
          e.note = `${data.length - kept.length} row(s) dropped for size; next_cursor resumes from the last row returned.`;
        }
        return e;
      };
      while (kept.length > 1 && JSON.stringify(envelope()).length > RESPONSE_SIZE_LIMIT) {
        kept = kept.slice(0, -1);
      }
      // A single row can still be oversized (a large `request.scope`); shrink it to
      // identity rather than emit sliced JSON.
      if (JSON.stringify(envelope()).length > RESPONSE_SIZE_LIMIT) {
        kept = kept.map((r) => ({ _id: r._id, status: r.status, analysisType: r.analysisType }));
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(envelope()) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
