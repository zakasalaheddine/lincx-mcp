/* eslint-disable camelcase -- Tool input / output fields and OAuth params are snake_case on the wire: protocol, not style. */
/**
 * tools/publisherTools.js
 *
 * list_publishers  — GET /api/publishers (paginated)
 * get_publisher    — GET /api/publishers/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, requiredNetworkIdShape } from './_shared.js'

export function registerPublisherTools (server) {
  // ── list_publishers ──────────────────────────────────────────────────────────
  server.registerTool('list_publishers', {
    title: 'List Publishers',
    description: 'List all publishers on the specified network with limit/offset pagination.',
    inputSchema: z.object({ ...requiredNetworkIdShape, ...paginationShape }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, network_id }, extra) => {
    const sessionId = await resolveLincxSession(extra)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId, network_id)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const data = await workApiRequest(v.session, 'GET', '/api/publishers', { networkId: network_id, params: { limit, offset } })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_publisher ────────────────────────────────────────────────────────────
  server.registerTool('get_publisher', {
    title: 'Get Publisher',
    description: 'Fetch full configuration of a publisher by ID.',
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: z.string().describe('Publisher ID')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, network_id }, extra) => {
    const sessionId = await resolveLincxSession(extra)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId, network_id)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const data = await workApiRequest(v.session, 'GET', `/api/publishers/${id}`)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
