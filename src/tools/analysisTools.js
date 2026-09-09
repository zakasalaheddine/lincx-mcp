/* eslint-disable camelcase -- Tool input / output fields and OAuth params are snake_case on the wire: protocol, not style. */
/**
 * tools/analysisTools.js
 *
 * get_analysis    — GET  /api/analysis/{id}
 * list_analyses   — GET  /api/analysis
 *
 * Zone tier analysis. The Work API runs a deterministic engine (aggregation,
 * reliability-weighted CPM, waterfall rank collapse, percentile tier banding)
 * and optionally a Gemini pass that only writes narrative on top of it.
 *
 * Jobs are created upstream (Work API UI / other clients), not by this server.
 * On a noLLM run the engine result comes back with the narrative fields empty
 * and the CALLING agent writes them — no second LLM bill, and the analysis
 * prompt lives in a skill where it can be iterated, not baked into this server.
 *
 * Each tool is one Work API call. Polling is the caller's job (get reports
 * status) — no orchestration here, per the server scope rule in CLAUDE.md.
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { RESPONSE_SIZE_LIMIT } from '../constants.js'
import { READONLY_ANNOTATIONS, requiredNetworkIdShape } from './_shared.js'

const ANALYSIS_STATUSES = ['queued', 'running', 'succeeded', 'failed']

/** Fields returned by list_analyses. Keeps a 100-row page well under the guard. */
const LIST_FIELDS = [
  '_id',
  'status',
  'analysisType',
  'name',
  'networkId',
  'request',
  'userCreated',
  'dateCreated',
  'dateCompleted',
  'error'
].join(',')

/**
 * Sections dropped unconditionally — never useful to the model, always big.
 *
 * `output.rawResponse` is the provider's raw text (a duplicate of output.json);
 * `input.prompt` is the rendered Gemini prompt, which is absent on noLLM runs
 * anyway and is exactly the thing a skill replaces.
 */
const ALWAYS_DROP = [
  ['output', 'rawResponse'],
  ['input', 'prompt']
]

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
const SHED_ORDER = [
  ['input', 'tieringContext', 'rankDistribution'],
  ['input', 'zoneMetrics'],
  ['input', 'rankedOfferOptimizationContext'],
  ['input', 'tieringContext', 'nonMonetizingCreatives'],
  ['input', 'tieringContext', 'defaultTierCreatives'],
  ['input', 'tieringContext', 'localTiers']
]

function deletePath (doc, path) {
  let node = doc
  for (const key of path.slice(0, -1)) {
    const next = node[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false
    node = next
  }
  const last = path[path.length - 1]
  if (!(last in node)) return false
  delete node[last]
  return true
}

function header (doc) {
  const request = (doc.request ?? {})
  const range = request.dateStart && request.dateEnd ? ` ${request.dateStart}..${request.dateEnd}` : ''
  const zone = request.zoneId ? ` zone ${request.zoneId}` : ''
  return `analysis ${doc._id ?? '?'} · ${doc.analysisType ?? '?'} · ${doc.status ?? '?'}${zone}${range}`
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
export function fitAnalysis (doc, limit) {
  // Cheap deep clone — the doc came off the wire as JSON.
  const trimmed = JSON.parse(JSON.stringify(doc ?? {}))
  const omitted = []

  for (const path of ALWAYS_DROP) deletePath(trimmed, path)

  const status = String(trimmed.status ?? '').toLowerCase()
  if (status === 'queued' || status === 'running') {
    trimmed.note = 'Job is not finished. Poll get_analysis again; do not report on a partial document.'
  }

  const wrap = (d) => ({
    content: [{ type: 'text', text: `${header(d)}\n\n${JSON.stringify(d)}` }]
  })
  const size = (d) => header(d).length + 2 + JSON.stringify(d).length

  if (size(trimmed) <= limit) return wrap(trimmed)

  for (const path of SHED_ORDER) {
    if (deletePath(trimmed, path)) {
      omitted.push(path.join('.'))
      trimmed.omitted = omitted
      if (size(trimmed) <= limit) return wrap(trimmed)
    }
  }

  // Last resort: the engine verdict plus provenance, explicitly flagged partial.
  const minimal = {
    _id: trimmed._id,
    status: trimmed.status,
    analysisType: trimmed.analysisType,
    networkId: trimmed.networkId,
    request: trimmed.request,
    error: trimmed.error,
    output: trimmed.output,
    complete: false,
    omitted: [...omitted, 'input'],
    note: 'Input context omitted — the document exceeded the response limit. output.json is complete; re-run over a shorter date range for the input breakdown.'
  }
  if (size(minimal) <= limit) return wrap(minimal)

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
    omitted: [...omitted, 'input', 'output'],
    note: 'Result exceeded the response limit even after shedding every input section. Re-run over a shorter date range, or read this analysis by id from the Work API directly.'
  })
}

export function registerAnalysisTools (server) {
  // ── get_analysis ────────────────────────────────────────────────────────────
  server.registerTool('get_analysis', {
    title: 'Get Zone Tier Analysis',
    description: `Fetch one analysis job by ID. Poll this until status is 'succeeded' or 'failed' ('queued'/'running' documents carry no results and say so in a note). Use list_analyses to discover job IDs.

Returns a one-line header, a blank line, then compact JSON — parse everything after the first blank line. On success the payload is:
- output.json — the engine verdict: structural_context, tier_grouping, tier_tables (TIER_1/TIER_2A/TIER_2B/TIER_3 rows with rank, ids, ctr, cpm, revenue, impressions, days_at_rank, localTier), risk_flags. On a noLLM run its narrative fields (tier_rationale, justification, confidence, improvement_guidance, next_actions) are EMPTY BY DESIGN.
- input.tieringContext — the scoring detail behind it: per-creative tierScore, revenueShare, isStable, assignedTier, assignedRank, slot metrics, localTiers + diagnostics, rankDistribution, riskFlags, datasetConfidence.
- input.zoneMetrics / input.dataQuality / input.warnings — daily zone rows and row-quality counts.
- execution — provider, model, token usage and cost (zeroed on noLLM runs).

Tier assignments are PRECOMPUTED. Do not re-cluster or re-rank them from the raw metrics. Oversized documents shed input sections (listed in an 'omitted' array), never the output verdict.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: z.string().describe('Analysis job ID')
    }).strict(),
    annotations: READONLY_ANNOTATIONS
  }, async ({ id, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const doc = await workApiRequest(v.session, 'GET', `/api/analysis/${id}`)
      return fitAnalysis(doc, RESPONSE_SIZE_LIMIT)
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── list_analyses ───────────────────────────────────────────────────────────
  server.registerTool('list_analyses', {
    title: 'List Zone Tier Analyses',
    description: `List analysis jobs on the specified network, newest first. Summary fields only (id, status, type, name, request, dates, error) — use get_analysis for results.

Pages by cursor, not offset: pass the '_id' of the last row you received as 'cursor' to get the next page. A 'next_cursor' is returned when a full page came back.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      status: z.enum(ANALYSIS_STATUSES).optional().describe('Only jobs in this status'),
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().optional().describe('The _id of the last row of the previous page')
    }).strict(),
    annotations: READONLY_ANNOTATIONS
  }, async ({ status, limit, cursor, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const params = { limit, fields: LIST_FIELDS }
      if (status !== undefined) params.status = status
      if (cursor !== undefined) params.cursor = cursor
      const res = await workApiRequest(v.session, 'GET', '/api/analysis', { networkId: network_id, params })

      const data = Array.isArray(res?.data) ? res.data : []

      // Drop whole rows, never slice the JSON — and recompute next_cursor from the
      // LAST KEPT row. Cursor paging is `_id < cursor`, so a cursor taken from a
      // row that was then dropped skips those jobs permanently.
      let kept = data
      const envelope = () => {
        const e = { count: kept.length, data: kept }
        if (data.length === limit) e.next_cursor = kept[kept.length - 1]?._id
        if (kept.length < data.length) {
          e.note = `${data.length - kept.length} row(s) dropped for size; next_cursor resumes from the last row returned.`
        }
        return e
      }
      while (kept.length > 1 && JSON.stringify(envelope()).length > RESPONSE_SIZE_LIMIT) {
        kept = kept.slice(0, -1)
      }
      // A single row can still be oversized (a large `request.scope`); shrink it to
      // identity rather than emit sliced JSON.
      if (JSON.stringify(envelope()).length > RESPONSE_SIZE_LIMIT) {
        kept = kept.map((r) => ({ _id: r._id, status: r.status, analysisType: r.analysisType }))
      }
      return { content: [{ type: 'text', text: JSON.stringify(envelope()) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
