/**
 * tools/creativeTools.js
 *
 * list_creatives        — GET /api/creatives (paginated)
 * get_creative          — GET /api/creatives/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes } from './_shared.js'

export function registerCreativeTools (server) {
  // ── list_creatives ───────────────────────────────────────────────────────────
  server.registerTool('list_creatives', {
    title: 'List Creatives',
    description: 'List creatives on the active network with limit/offset pagination. Pass advertiserId to enumerate one advertiser\'s creatives exhaustively; without it, the whole network is listed.',
    inputSchema: z.object({
      advertiserId: z.string().optional().describe('Only creatives for this advertiser'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, advertiserId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { limit, offset }
      if (advertiserId !== undefined) params.advertiserId = advertiserId
      const data = await workApiRequest(v.session, 'GET', '/api/creatives', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_creative ─────────────────────────────────────────────────────────────
  server.registerTool('get_creative', {
    title: 'Get Creative',
    description: 'Fetch full configuration of a creative by ID.',
    inputSchema: z.object({
      id: z.string().describe('Creative ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await getEntityWithIncludes(v.session, '/api/creatives', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
