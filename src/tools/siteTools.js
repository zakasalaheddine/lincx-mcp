/**
 * tools/siteTools.js
 *
 * list_sites        — GET /api/sites (paginated)
 * get_site          — GET /api/sites/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes } from './_shared.js'

export function registerSiteTools (server) {
  // ── list_sites ───────────────────────────────────────────────────────────────
  server.registerTool('list_sites', {
    title: 'List Sites',
    description: 'List sites on the active network with limit/offset pagination. Pass a parent filter to enumerate one parent\'s sites exhaustively (upstream applies the first of publisherId → channelId); without a filter, the whole network is listed.',
    inputSchema: z.object({
      publisherId: z.string().optional().describe('Only sites for this publisher'),
      channelId: z.string().optional().describe('Only sites in this channel'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, publisherId, channelId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { limit, offset }
      if (publisherId !== undefined) params.publisherId = publisherId
      if (channelId !== undefined) params.channelId = channelId
      const data = await workApiRequest(v.session, 'GET', '/api/sites', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_site ─────────────────────────────────────────────────────────────────
  server.registerTool('get_site', {
    title: 'Get Site',
    description: 'Fetch full configuration of a site by ID.',
    inputSchema: z.object({
      id: z.string().describe('Site ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await getEntityWithIncludes(v.session, '/api/sites', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
