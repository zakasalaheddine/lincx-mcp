/**
 * tools/adGroupTools.js
 *
 * list_ad_groups        — GET /api/ad-groups (paginated)
 * get_ad_group          — GET /api/ad-groups/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes } from './_shared.js'

export function registerAdGroupTools (server) {
  // ── list_ad_groups ───────────────────────────────────────────────────────────
  server.registerTool('list_ad_groups', {
    title: 'List Ad Groups',
    description: 'List ad groups on the active network with limit/offset pagination. Pass a parent filter to enumerate one parent\'s ad groups exhaustively (upstream applies the first of campaignId → advertiserId; without a filter, the whole network is listed).',
    inputSchema: z.object({
      advertiserId: z.string().optional().describe('Only ad groups for this advertiser'),
      campaignId: z.string().optional().describe('Only ad groups in this campaign'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, advertiserId, campaignId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { limit, offset }
      if (advertiserId !== undefined) params.advertiserId = advertiserId
      if (campaignId !== undefined) params.campaignId = campaignId
      const data = await workApiRequest(v.session, 'GET', '/api/ad-groups', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_ad_group ─────────────────────────────────────────────────────────────
  server.registerTool('get_ad_group', {
    title: 'Get Ad Group',
    description: 'Fetch full configuration of an ad group by ID.',
    inputSchema: z.object({
      id: z.string().describe('Ad Group ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await getEntityWithIncludes(v.session, '/api/ad-groups', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
