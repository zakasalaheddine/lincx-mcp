/**
 * tools/experienceTools.js
 *
 * list_experiences — GET /api/experiences
 * get_experience   — GET /api/experiences/{id}
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape } from './_shared.js'

export function registerExperienceTools (server) {
  // ── list_experiences ─────────────────────────────────────────────────────────
  server.registerTool('list_experiences', {
    title: 'List Experiences',
    description: "List experiences on the active network with limit/offset pagination. Experiences define the ad delivery context (placement, targeting rules, etc.). Pass a parent filter to enumerate one parent's experiences exhaustively (upstream applies the first of publisherId → channelId → siteId); without a filter, the whole network is listed.",
    inputSchema: z.object({
      publisherId: z.string().optional().describe('Only experiences for this publisher'),
      channelId: z.string().optional().describe('Only experiences in this channel'),
      siteId: z.string().optional().describe('Only experiences on this site'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, publisherId, channelId, siteId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const params = { limit, offset }
      if (publisherId !== undefined) params.publisherId = publisherId
      if (channelId !== undefined) params.channelId = channelId
      if (siteId !== undefined) params.siteId = siteId
      const data = await workApiRequest(v.session, 'GET', '/api/experiences', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_experience ───────────────────────────────────────────────────────────
  server.registerTool('get_experience', {
    title: 'Get Experience',
    description: 'Fetch full details of an experience by ID.',
    inputSchema: z.object({
      id: z.string().describe('Experience ID')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await workApiRequest(v.session, 'GET', `/api/experiences/${id}`)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
