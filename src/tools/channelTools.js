/**
 * tools/channelTools.js
 *
 * list_channels        — GET /api/channels (paginated)
 * get_channel          — GET /api/channels/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes } from './_shared.js'

export function registerChannelTools (server) {
  // ── list_channels ────────────────────────────────────────────────────────────
  server.registerTool('list_channels', {
    title: 'List Channels',
    description: 'List channels on the active network with limit/offset pagination. Pass publisherId to enumerate one publisher\'s channels exhaustively; without it, the whole network is listed.',
    inputSchema: z.object({
      publisherId: z.string().optional().describe('Only channels for this publisher'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, publisherId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { limit, offset }
      if (publisherId !== undefined) params.publisherId = publisherId
      const data = await workApiRequest(v.session, 'GET', '/api/channels', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_channel ──────────────────────────────────────────────────────────────
  server.registerTool('get_channel', {
    title: 'Get Channel',
    description: 'Fetch full configuration of a channel by ID.',
    inputSchema: z.object({
      id: z.string().describe('Channel ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await getEntityWithIncludes(v.session, '/api/channels', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
