/**
 * tools/adTools.js
 *
 * list_ads        — GET /api/ads (paginated)
 * get_ad          — GET /api/ads/{id}
 * get_zone_ads    — GET /api/ads/ad (ad-serving endpoint)
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes } from './_shared.js'

export function registerAdTools (server) {
  // ── list_ads ─────────────────────────────────────────────────────────────────
  server.registerTool('list_ads', {
    title: 'List Ads',
    description: 'List ads on the active network with limit/offset pagination. Pass a parent filter to enumerate one parent\'s ads exhaustively (upstream applies the first of adGroupId → campaignId → advertiserId; without a filter, the whole network is listed).',
    inputSchema: z.object({
      adGroupId: z.string().optional().describe('Only ads in this ad group'),
      campaignId: z.string().optional().describe('Only ads in this campaign'),
      advertiserId: z.string().optional().describe('Only ads for this advertiser'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, adGroupId, campaignId, advertiserId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { limit, offset }
      if (adGroupId !== undefined) params.adGroupId = adGroupId
      if (campaignId !== undefined) params.campaignId = campaignId
      if (advertiserId !== undefined) params.advertiserId = advertiserId
      const data = await workApiRequest(v.session, 'GET', '/api/ads', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_ad ───────────────────────────────────────────────────────────────────
  server.registerTool('get_ad', {
    title: 'Get Ad',
    description: 'Fetch full configuration of an ad by ID.',
    inputSchema: z.object({
      id: z.string().describe('Ad ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await getEntityWithIncludes(v.session, '/api/ads', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_zone_ads ─────────────────────────────────────────────────────────────
  server.registerTool('get_zone_ads', {
    title: 'Get Zone Ads',
    description: 'Calls the ad-serving endpoint for a zone. Returns the ads that would be shown and the template they render into ({ ads, template }). Set debug: true to hit the debug endpoint instead, which explains which ad-groups matched and which were rejected.',
    inputSchema: z.object({
      zoneId: z.string().describe('Zone ID to fetch serving ads for'),
      debug: z.boolean().optional().default(false).describe('Hit /api/ads/ad/debug instead of /api/ads/ad — returns ad-group match/reject diagnostics'),
      adFeedCount: z.number().int().optional(),
      geoState: z.string().optional(),
      geoCity: z.string().optional(),
      geoIP: z.string().optional(),
      geoPostal: z.string().optional(),
      geoCountry: z.string().optional(),
      scoreKey: z.string().optional()
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ zoneId, debug, adFeedCount, geoState, geoCity, geoIP, geoPostal, geoCountry, scoreKey }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { zoneId }
      if (adFeedCount !== undefined) params.adFeedCount = adFeedCount
      if (geoState !== undefined) params.geoState = geoState
      if (geoCity !== undefined) params.geoCity = geoCity
      if (geoIP !== undefined) params.geoIP = geoIP
      if (geoPostal !== undefined) params.geoPostal = geoPostal
      if (geoCountry !== undefined) params.geoCountry = geoCountry
      if (scoreKey !== undefined) params.scoreKey = scoreKey

      const data = await workApiRequest(v.session, 'GET', debug ? '/api/ads/ad/debug' : '/api/ads/ad', { params })
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
