/**
 * tools/zoneTools.js
 *
 * list_zones          — GET /api/zones (paginated)
 * get_zone            — GET /api/zones/{id}
 * get_zone_report     — GET /api/zones/{id}/report
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError, truncateIfNeeded, fitEntityToText, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes } from './_shared.js'

export function registerZoneTools (server) {
  // ── list_zones ──────────────────────────────────────────────────────────────
  server.registerTool('list_zones', {
    title: 'List Zones',
    description: 'List zones on the active network. Pass a parent filter to enumerate one parent\'s zones exhaustively (upstream applies the first of publisherId → channelId → siteId; without a filter, the whole network is listed). Use get_zone for full config of a specific zone.',
    inputSchema: z.object({
      publisherId: z.string().optional().describe('Only zones for this publisher'),
      channelId: z.string().optional().describe('Only zones in this channel'),
      siteId: z.string().optional().describe('Only zones on this site'),
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
      const data = await workApiRequest(v.session, 'GET', '/api/zones', { params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_zone ────────────────────────────────────────────────────────────────
  server.registerTool('get_zone', {
    title: 'Get Zone',
    description: 'Fetch full configuration of a zone by ID.',
    inputSchema: z.object({
      id: z.string().describe('Zone ID'),
      ...includeShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await getEntityWithIncludes(v.session, '/api/zones', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_zone_report ─────────────────────────────────────────────────────────
  server.registerTool('get_zone_report', {
    title: 'Get Zone Report',
    description: 'Fetch timeseries report data for a zone.',
    inputSchema: z.object({
      id: z.string().describe('Zone ID'),
      resolution: z.enum(['day', 'hour']).default('day'),
      startDate: z.string().describe('ISO date e.g. 2026-01-01'),
      endDate: z.string().describe('ISO date e.g. 2026-01-31')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, resolution, startDate, endDate }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await workApiRequest(v.session, 'GET', `/api/zones/${id}/report`, { params: { resolution, startDate, endDate } })
      const text = JSON.stringify(data)
      return { content: [{ type: 'text', text: truncateIfNeeded(text) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
