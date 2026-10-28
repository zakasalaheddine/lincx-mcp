/* eslint-disable camelcase -- Tool input / output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/dimensionSetTools.js
 *
 * create_dimension_set — POST /api/dimension-sets
 *
 * A dimension set is a "report" in Reports Center: report_query reads one, and
 * can only group/filter by the dimensions the set carries.
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { requiredNetworkIdShape } from './_shared.js'

const text = (t) => ({ content: [{ type: 'text', text: t }] })

// lincx-core server/model/dimension-set.js `dPairs`: asking for one side adds the other.
const PAIRS = [
  ['networkId', 'network'], ['advertiserId', 'advertiser'], ['campaignId', 'campaign'],
  ['adGroupId', 'adGroup'], ['adId', 'ad'], ['creativeId', 'creative'], ['publisherId', 'publisher'],
  ['channelId', 'channel'], ['siteId', 'site'], ['experienceId', 'experience'],
  ['templateId', 'template'], ['zoneId', 'zone']
]

// Event columns lincx-core knows (dbs/ch-fields-schema-def) plus date/hour. Anything else is a
// custom dimension, and upstream registers an unseen one on the network permanently.
const CORE_DIMENSIONS = new Set([
  'date', 'hour', 'type', 's1', 's2', 's3', 'geoCity', 'geoCountry', 'geoRegion', 'geoPostal',
  'originId', 'device', 'deviceOs', 'rank', 'price', 'revShare', 'cost', 'adverseClickId', ...PAIRS.flat()
])

/**
 * The dimension list upstream will store: de-duplicated, id/name pairs added,
 * and in the order it demands — `date, networkId` or `date, hour, networkId`
 * first (anything else is rejected, however valid the dimensions).
 */
export function normalizeDimensions (dimensions) {
  const all = new Set([...dimensions, 'date', 'networkId'])
  for (const [a, b] of PAIRS) if (all.has(a) || all.has(b)) { all.add(a); all.add(b) }
  const base = all.has('hour') ? ['date', 'hour', 'networkId'] : ['date', 'networkId']
  return [...base, ...[...all].filter(d => !base.includes(d))]
}

export const sameDimensions = (a, b) => a.length === b.length && a.every(d => b.includes(d))

/** Requested dimensions the network has never used: a typo here becomes a permanent custom dimension. */
export function unknownDimensions (dimensions, sets) {
  const known = new Set([...CORE_DIMENSIONS, ...sets.flatMap(s => s.dimensions ?? [])])
  return dimensions.filter(d => !known.has(d))
}

export const unknownDimensionsError = (names) =>
  `Error: ${names.map(n => `"${n}"`).join(', ')} ${names.length > 1 ? 'are' : 'is'} not a dimension this network has used. An unseen name is registered on the network as a permanent custom dimension, so a typo would stay. Check the spelling (get_event_stats_keys lists the custom keys), or pass allowNewDimensions: true if it is really new.`

export const dimensionsShape = {
  // eslint-disable-next-line no-control-regex
  dimensions: z.array(z.string().trim().min(1).max(100).refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'dimension names must not contain control characters')).min(1).max(40).describe("Dimension names the report must carry, e.g. ['zone', 'hour']. date, networkId and the id/name pair of each entity dimension are added for you."),
  allowNewDimensions: z.boolean().optional().describe('Allow a dimension name this network has never used. It is then registered as a permanent custom dimension, so leave unset unless the name is certainly right.')
}

async function listSets (session, networkId) {
  const res = await workApiRequest(session, 'GET', '/api/dimension-sets', { networkId })
  return res?.data ?? res
}

const summary = (s) => ({ id: s.id, name: s.name, dimensions: s.dimensions })

export function registerDimensionSetWriteTools (server) {
  server.registerTool('create_dimension_set', {
    title: 'Create Dimension Set',
    description: `Create a new report (dimension set) carrying the dimensions a question needs, when no existing report has them. Prefer this over editing a report others use.
If an active report on the network already has exactly these dimensions it is returned instead of creating a duplicate.
date, networkId and the id/name pair of each entity dimension (zone ⇒ zoneId) are added and ordered for you; pass 'hour' for hourly rows (about 24x more rows — see report_query).
Upstream limits, passed through if hit: at most 50 active reports per network, at most 12 dimensions beyond the entity/date ones, and no report equal to a system report.
A dimension name the network has never used is refused unless allowNewDimensions: true, because upstream would register it permanently.
Returns { id, name, dimensions } — run report_query with that id next. Not idempotent: on a timeout, check list_dimension_sets for the name before retrying.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      // eslint-disable-next-line no-control-regex
      name: z.string().trim().min(1, 'name must not be blank').max(50).refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'name must not contain control characters or newlines').describe('Report name, up to 50 characters'),
      ...dimensionsShape
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ network_id, name, dimensions, allowNewDimensions }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return text("Error: Not authenticated. Use 'auth_login' first.")

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return text(`Error: ${v.error}`)

    const wanted = normalizeDimensions(dimensions)
    try {
      const sets = await listSets(v.session, network_id)
      const same = sets.find(s => !s.archived && sameDimensions(s.dimensions ?? [], wanted))
      if (same) return text(`A report with these dimensions already exists: ${same.id} "${same.name}". Nothing created.\n\n${JSON.stringify(summary(same))}`)

      const unknown = allowNewDimensions ? [] : unknownDimensions(wanted, sets)
      if (unknown.length) return text(unknownDimensionsError(unknown))

      const res = await workApiRequest(v.session, 'POST', '/api/dimension-sets', { body: { networkId: network_id, name, dimensions: wanted }, timeoutMs: 30_000 })
      const s = res?.data ?? res
      return text(`Created report ${s.id} "${s.name}".\n\n${JSON.stringify(summary(s))}`)
    } catch (err) {
      if (err.code === 'TIMEOUT' || err.status >= 500) return text(`Error: create ${err.code === 'TIMEOUT' ? 'timed out' : `failed (${err.status})`} — the report MAY have been created. Check 'list_dimension_sets' for "${name}" before retrying.`)
      if (err.status === 403) return text(`Error: Forbidden — your user can't create reports on network ${network_id}.`)
      return text(handleWorkApiError(err))
    }
  })
}
