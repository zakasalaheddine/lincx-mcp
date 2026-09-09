/* eslint-disable camelcase -- Tool input / output fields and OAuth params are snake_case on the wire: protocol, not style. */
/**
 * tools/campaignTools.js
 *
 * list_campaigns        — GET /api/campaigns (paginated)
 * get_campaign          — GET /api/campaigns/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes, requiredNetworkIdShape } from './_shared.js'

export function registerCampaignTools (server) {
  // ── list_campaigns ───────────────────────────────────────────────────────────
  server.registerTool('list_campaigns', {
    title: 'List Campaigns',
    description: 'List campaigns on the specified network with limit/offset pagination. Pass advertiserId to enumerate one advertiser\'s campaigns exhaustively; without it, the whole network is listed.',
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      advertiserId: z.string().optional().describe('Only campaigns for this advertiser'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, advertiserId, network_id }, extra) => {
    const sessionId = await resolveLincxSession(extra)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId, network_id)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const params = { limit, offset }
      if (advertiserId !== undefined) params.advertiserId = advertiserId
      const data = await workApiRequest(v.session, 'GET', '/api/campaigns', { networkId: network_id, params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_campaign ─────────────────────────────────────────────────────────────
  server.registerTool('get_campaign', {
    title: 'Get Campaign',
    description: 'Fetch full configuration of a campaign by ID.',
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: z.string().describe('Campaign ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include, network_id }, extra) => {
    const sessionId = await resolveLincxSession(extra)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId, network_id)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const data = await getEntityWithIncludes(v.session, '/api/campaigns', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
