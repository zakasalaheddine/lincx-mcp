/* eslint-disable camelcase -- Tool input / output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/auditTools.js
 *
 * get_user_actions — GET /api/networks/{network_id}/user-actions
 *
 * "Who turned this ad group off, and when?" — the question explain_serve cannot
 * answer. It can tell you a group is disabled; it cannot tell you who disabled
 * it, so those investigations ended in the UI or in Slack.
 *
 * The network is in the PATH here, not the ?networkId query param, so this is the
 * one read whose network_id argument is interpolated into the URL instead of
 * being handed to workApiRequest as options.networkId — that option only adds a
 * query param on the exact list paths in NETWORK_LIST_PATHS, so passing it here
 * would be a silent no-op. The argument is still required, and is still the only
 * source of scope.
 *
 * WHAT THIS IS NOT: a field-level diff. An `update` row says an entity was
 * updated. It does not say which field changed, or what the value was before.
 * That limit is stated in the tool description and repeated in the response,
 * because a model reading `type: update` next to a drop in delivery will
 * otherwise present a guess as a finding.
 *
 * Three shapes here are upstream's, not ours, and each one fails SILENTLY when
 * it is got wrong — an empty change log reads as "nobody touched it", which is
 * the one answer this tool must never give by accident:
 *  - `model` matches the STORED value, which lincx-core writes as
 *    `_.camelCase(model.name)` and filters with an exact `_.isMatch`. 'AdGroup'
 *    against a stored 'adGroup' is simply false, with no error. Hence the enum.
 *  - the dates are ajv `format: 'date-time'`; a bare '2026-08-01' is a 422.
 *  - with no dates at all upstream defaults the window to the last 14 days, so
 *    a group disabled three weeks ago returns nothing. We default and SEND the
 *    window ourselves so the response can echo exactly what was asked for.
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, requiredNetworkIdShape, READONLY_ANNOTATIONS } from './_shared.js'

const err = (text) => ({ content: [{ type: 'text', text }] })

const ACTION_TYPES = ['create', 'clone', 'update', 'archive', 'unarchive', 'move', 'ownershipChange']

/**
 * The stored `entity` values, which is what upstream's `model` filter matches.
 * lincx-core writes `entity: _.camelCase(model.name)` for every model it tracks
 * and filters with `_.isMatch(row, { entity: model })` — an exact compare — so a
 * value that is merely close returns zero rows and no error. Closed enum on
 * purpose: a rejected argument is recoverable, an empty audit log is not.
 */
const ACTION_MODELS = [
  'adGroup', 'ad', 'advertiser', 'campaign', 'channel', 'creative',
  'creativeAssetGroup', 'dimensionSet', 'event', 'experience', 'metazone',
  'network', 'publisher', 'site', 'template', 'userSettings', 'zone'
]

const DEFAULT_WINDOW_DAYS = 14

const NO_DIFF_NOTE = 'Entity-grain log: each row says WHO touched WHAT and WHEN. There is no field-level diff — an "update" row does not carry which field changed or its previous value.'

/**
 * Normalise a bound to the RFC-3339 form ajv's `format: "date-time"` demands.
 *
 * Bare dates are what a model writes, and upstream 422s them ('data.dateStart
 * should match format "date-time"'). Expanding them is asymmetric because the
 * upstream query is `_id: { $gte: key(dateStart), $lt: key(dateEnd) }`: an
 * EXCLUSIVE end. '2026-08-31' as the end must become the following midnight, or
 * the whole of Aug 31 — usually the day you are asking about — drops out, which
 * is the same silent-empty failure as the rest of this file.
 *
 * Everything is then round-tripped to Z form: upstream compares the two bounds
 * with `>`, a lexicographic STRING compare, so mixing '+02:00' and 'Z' can 422
 * on a window that is actually fine.
 */
export function toDateTime (value, { end = false } = {}) {
  const bare = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const d = new Date(bare ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(d.getTime())) return value
  if (bare && end) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}

/**
 * The window actually sent upstream.
 *
 * Upstream defaults dateStart to now − 2 weeks and dateEnd to now, which means
 * `get_user_actions({ entityId })` on a group disabled three weeks ago returns
 * total: 0 — indistinguishable from "nobody touched it". We resolve the window
 * here instead, so the response can echo the exact bounds it was answered for.
 *
 * The default start is relative to the END, not to now. Upstream's now-anchored
 * default 422s ('dateStart should be earlier then dateEnd') whenever a caller
 * passes only a dateEnd older than two weeks — a reasonable request that has no
 * business failing.
 */
export function resolveWindow (dateStart, dateEnd) {
  const end = dateEnd === undefined ? new Date().toISOString() : toDateTime(dateEnd, { end: true })
  const start = dateStart === undefined
    ? new Date(new Date(end).getTime() - DEFAULT_WINDOW_DAYS * 86400000).toISOString()
    : toDateTime(dateStart)
  return {
    dateStart: start,
    dateEnd: end,
    ...(dateStart === undefined || dateEnd === undefined ? { defaulted: true } : {})
  }
}

/**
 * Scope rows to one entity id.
 *
 * Upstream has no entityId filter — it filters by action type, model, user and
 * date only — so this runs server-side over the fetched rows, the same shape as
 * report_query's `filter`. Doing it here rather than in the model is the whole
 * point: "who turned THIS ad group off" otherwise means paging a network's entire
 * action log through context to find three rows.
 */
export function filterByEntityId (rows, entityId) {
  if (entityId === undefined) return rows
  return rows.filter((r) => r !== null && typeof r === 'object' && String(r.entityId ?? '') === entityId)
}

/**
 * Trade Mongo's `_id` for the `eventId` the row shape advertises.
 *
 * Upstream stores neither an `eventId` field nor a clean id: `_id` is a pathkey,
 * 'networkId-eventId\xff<networkId>\xff<eventId>'. Passed through it duplicates
 * two fields the row already carries and puts a raw \xff in the response; dropped
 * outright it takes the only per-event identifier with it. Take the last segment.
 */
export function withEventId (rows) {
  return rows.map((r) => {
    if (r === null || typeof r !== 'object') return r
    const { _id, ...rest } = r
    if (_id === undefined) return r
    return { ...rest, eventId: rest.eventId ?? String(_id).split('\xff').pop() }
  })
}

/** Newest first — see the description; page 1 must hold "who just turned this off". */
export function newestFirst (rows) {
  return [...rows].sort((a, b) => String(b?.timestamp ?? '').localeCompare(String(a?.timestamp ?? '')))
}

export function registerAuditTools (server) {
  server.registerTool('get_user_actions', {
    title: 'Get User Actions Log',
    description: `The change log for one network — who created, cloned, updated, archived, unarchived, moved or reassigned an entity, and when. This is the "who turned this ad group off, and when?" read: explain_serve can tell you a group is disabled, never who disabled it.

IMPORTANT — THIS IS ENTITY GRAIN, NOT FIELD GRAIN. A row says an entity was updated. It does NOT say which field changed, or what the value was before. So "type: update at 14:02" is not evidence of why delivery changed at 14:02; it is evidence that someone touched the entity. Report it as that and no further.

DEFAULT WINDOW IS THE LAST ${DEFAULT_WINDOW_DAYS} DAYS. Anything older needs an explicit dateStart — without one, a group archived three weeks ago comes back as total: 0, which is NOT "nobody touched it". The window actually used is echoed in the response as \`window\`.

Each row: { type, timestamp, entity, entityName, entityId, user, eventId, network, networkId }. Rows are newest first. Filter with type / model / user / dateStart / dateEnd (all passed to the API) and entityId (applied server-side — the endpoint has no entity filter, so rows are fetched for the network and narrowed here). Paged with limit/offset and the standard envelope: page until next_offset is absent.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      entityId: z.string().optional()
        .describe('Scope to a single entity by its id — the usual way in ("what happened to this ad group"). Applied server-side after the fetch, since the endpoint has no entity filter. Widen dateStart to look further back; the fetch is bounded by the window, not by this.'),
      model: z.enum(ACTION_MODELS).optional()
        .describe("Scope to one entity TYPE. Passed to the API as its `model` filter, which is an EXACT match against the stored camelCase name — 'adGroup', not 'AdGroup' or 'ad_group'."),
      type: z.enum(ACTION_TYPES).optional()
        .describe('Scope to one action type.'),
      user: z.string().email().optional()
        .describe('Scope to one user, by email.'),
      dateStart: z.string().optional()
        .describe(`Lower bound, inclusive: '2026-08-01' or '2026-08-01T00:00:00Z'. Defaults to ${DEFAULT_WINDOW_DAYS} days before dateEnd — pass it explicitly to look further back.`),
      dateEnd: z.string().optional()
        .describe("Upper bound: '2026-08-31' covers all of Aug 31 (a bare date is expanded to the end of that day). Defaults to now."),
      ...paginationShape
    }).strict(),
    annotations: READONLY_ANNOTATIONS
  }, async ({ network_id, entityId, model, type, user, dateStart, dateEnd, limit, offset, fields }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return err("Error: Not authenticated. Use 'auth_login' first.")

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return err(`Error: ${v.error}`)

    try {
      const window = resolveWindow(dateStart, dateEnd)
      const params = { dateStart: window.dateStart, dateEnd: window.dateEnd }
      if (model !== undefined) params.model = model
      if (type !== undefined) params.type = type
      if (user !== undefined) params.user = user

      // The network scopes this endpoint through the PATH, not ?networkId.
      const data = await workApiRequest(
        v.session, 'GET', `/api/networks/${network_id}/user-actions`, { params }
      )

      const fetched = Array.isArray(data) ? data : (data?.data ?? data?.items ?? [])
      const rows = newestFirst(withEventId(filterByEntityId(fetched, entityId)))
      // Default to whole rows: the standard projection keeps { id, name } plus
      // status fields, and an action row has none of those — it would come back
      // near-empty. Rows are seven short scalars, so '*' is cheap here.
      const envelope = buildListEnvelope(rows, { limit, offset, fields: fields ?? ['*'] })
      const text = listEnvelopeToText({ ...envelope, window, grain: NO_DIFF_NOTE })
      return { content: [{ type: 'text', text }] }
    } catch (e) {
      return err(handleWorkApiError(e))
    }
  })
}
