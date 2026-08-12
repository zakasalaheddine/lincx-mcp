/**
 * index.js — Lincx MCP Server entry point
 *
 * Two surfaces on one bare Node HTTP server:
 *  1. HTTP login UI (GET /login, POST /api/login, GET /login/success)
 *  2. MCP Streamable HTTP transport (POST|GET|DELETE /mcp)
 *
 * The server is HTTP-only — MCP clients connect over /mcp. There is no stdio
 * transport; everything (Claude Code, Desktop, claude.ai) connects by URL.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import { registerAuthTools } from './tools/authTools.js'
import { registerNetworkTools } from './tools/networkTools.js'
import { registerTemplateTools } from './tools/templateTools.js'
import { registerCreativeAssetGroupTools } from './tools/creativeAssetGroupTools.js'
import { registerZoneTools } from './tools/zoneTools.js'
import { registerAdTools } from './tools/adTools.js'
import { registerAdGroupTools } from './tools/adGroupTools.js'
import { registerCreativeTools } from './tools/creativeTools.js'
import { registerCampaignTools } from './tools/campaignTools.js'
import { registerChannelTools } from './tools/channelTools.js'
import { registerSiteTools } from './tools/siteTools.js'
import { registerPublisherTools } from './tools/publisherTools.js'
import { registerAdvertiserTools } from './tools/advertiserTools.js'
import { registerExperienceTools } from './tools/experienceTools.js'
import { registerReportingTools } from './tools/reportingTools.js'
import { registerZoneInventoryTools } from './tools/zoneInventoryTools.js'
import { registerZoneEligibilityTools } from './tools/zoneEligibilityTools.js'
import { registerAnalysisTools } from './tools/analysisTools.js'
import { registerResources } from './tools/resources.js'
import { installToolGuards } from './middleware/toolGuard.js'
import { mcpLimiter } from './middleware/rateLimit.js'
import { SERVER_PORT, IS_PRODUCTION, PUBLIC_BASE_URL } from './constants.js'
import {
  resolveLincxSessionFromBearer,
  bindMcpToLincxSession
} from './services/sessionManager.js'
import { buildRouter, onRouterError } from './http/router.js'
import { json, noContent } from './http/respond.js'
import { header, readBody } from './http/request.js'

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────────────

// A single McpServer (Protocol) instance can be bound to exactly ONE transport.
// The Streamable HTTP transport is per-session, so we build a fresh server for
// each session via this factory rather than sharing one across all sessions —
// sharing throws "Already connected to a transport" on the second session.
function createMcpServer () {
  const server = new McpServer({ name: 'lincx-mcp-server', version: '1.0.0' })

  registerAuthTools(server)
  registerNetworkTools(server)
  registerTemplateTools(server)
  registerCreativeAssetGroupTools(server)
  registerZoneTools(server)
  registerAdTools(server)
  registerAdGroupTools(server)
  registerCreativeTools(server)
  registerCampaignTools(server)
  registerChannelTools(server)
  registerSiteTools(server)
  registerPublisherTools(server)
  registerAdvertiserTools(server)
  registerExperienceTools(server)
  registerReportingTools(server)
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)
  registerAnalysisTools(server)
  registerResources(server)

  // Wrap every registered tool handler with the response-size guard + metrics
  // logging. Must run after all register*Tools() calls above.
  installToolGuards(server)

  return server
}

// ── MCP HTTP transport — per-session ────────────────────────────────────────
const transports = new Map()

async function createTransport () {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      transports.set(id, transport)
      console.error(`[MCP]    session initialized: ${id}`)
    }
  })
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId)
      console.error(`[MCP]    session closed: ${transport.sessionId}`)
    }
  }
  // A dedicated server instance per transport — see createMcpServer().
  const mcpServer = createMcpServer()
  try {
    await mcpServer.connect(transport)
  } catch (err) {
    await transport.close().catch(() => {})
    throw err
  }
  return transport
}

function bearerChallengeHeader () {
  return `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`
}

/** 401 + the RFC-9728 challenge. `withBody` matches what each method used to send. */
function unauthorized (res, withBody) {
  res.setHeader('WWW-Authenticate', bearerChallengeHeader())
  if (withBody) {
    json(res, 401, { error: 'unauthorized', error_description: 'Bearer token required.' })
  } else {
    noContent(res, 401)
  }
}

async function mcpPost (req, res, _opts, cb) {
  if (!mcpLimiter(req, res)) return

  // TEMPORARY probe (remove after the Phase 0 GAE decision — see #64).
  // Gives GET /mcp below a denominator to be measured against.
  console.error(JSON.stringify({ probe: 'POST /mcp', ua: header(req, 'user-agent') ?? '' }))

  let body
  try {
    // POST reads the stream HERE and hands the parsed body to the transport
    // below. The SDK accepts a pre-parsed body as handleRequest's 3rd argument
    // or reads the stream itself — doing half of each (reading here, not
    // passing it) leaves it awaiting a consumed stream forever.
    body = await readBody(req)
  } catch (err) {
    return cb(err)
  }

  try {
    const lincxSessionId = await resolveLincxSessionFromBearer(header(req, 'authorization'))
    if (!lincxSessionId) return unauthorized(res, true)

    const existingId = header(req, 'mcp-session-id')
    let transport

    if (existingId && transports.has(existingId)) {
      // Established session — reuse its transport (and its server).
      transport = transports.get(existingId)
    } else if (!existingId && isInitializeRequest(body)) {
      // New session handshake — stand up a fresh transport + server.
      transport = await createTransport()
    } else {
      // Unknown/stale session id, or a non-initialize request without a session.
      // (Common after a server restart drops in-memory transports — tell the
      // client to re-initialize instead of silently minting a new session.)
      return json(res, 400, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: {
          code: -32000,
          message: 'Bad Request: unknown or missing MCP session ID. Re-initialize the session.'
        }
      })
    }

    // Refresh the transport→Lincx binding on every request so reconnects (new
    // transport id) inherit the OAuth-resolved Lincx session immediately.
    if (transport.sessionId) {
      await bindMcpToLincxSession(transport.sessionId, lincxSessionId)
    }

    await transport.handleRequest(req, res, body)
  } catch (err) {
    console.error('[MCP]    POST /mcp error:', err instanceof Error ? err.message : String(err))
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32603, message: 'Internal server error.' }
      })
    }
  }
}

// GET and DELETE take NO body reader. GET /mcp is the long-lived SSE stream;
// awaiting a body on it would hang the request forever, and the SDK reads
// whatever it needs from the raw request itself.
async function mcpGet (req, res) {
  // TEMPORARY probe (remove after the Phase 0 GAE decision — see #64).
  //
  // enableJsonResponse:true above means POST /mcp answers with application/json,
  // so THIS handler is the only SSE surface in the whole server. Whether any real
  // client opens it decides whether App Engine's request-duration behaviour
  // matters at all. Measure before designing a spike around it.
  //
  // No token, no session id, no header values beyond the user-agent — nothing here
  // is a credential.
  console.error(JSON.stringify({
    probe: 'GET /mcp',
    ua: header(req, 'user-agent') ?? '',
    has_session: Boolean(header(req, 'mcp-session-id')),
    has_auth: Boolean(header(req, 'authorization')),
    accept: header(req, 'accept') ?? ''
  }))

  const lincxSessionId = await resolveLincxSessionFromBearer(header(req, 'authorization'))
  if (!lincxSessionId) return unauthorized(res, false)

  const existingId = header(req, 'mcp-session-id')
  if (!existingId || !transports.has(existingId)) {
    return json(res, 404, { error: 'Unknown MCP session.' })
  }
  await transports.get(existingId).handleRequest(req, res)
}

async function mcpDelete (req, res) {
  const lincxSessionId = await resolveLincxSessionFromBearer(header(req, 'authorization'))
  if (!lincxSessionId) return unauthorized(res, false)

  const existingId = header(req, 'mcp-session-id')
  if (!existingId || !transports.has(existingId)) return noContent(res, 404)
  await transports.get(existingId).handleRequest(req, res)
}

// ── Dev debug routes (non-production only) ───────────────────────────────────

function buildDevHandlers () {
  if (IS_PRODUCTION) return null
  const registeredTools = createMcpServer()._registeredTools
  return {
    list: (_req, res) => {
      const tools = Object.entries(registeredTools).map(([name, t]) => ({ name, description: t.description }))
      json(res, 200, { tools })
    },
    call: async (req, res, opts, cb) => {
      const tool = registeredTools[opts.params.name]
      if (!tool) return json(res, 404, { error: `Tool '${opts.params.name}' not found` })
      let body
      try { body = await readBody(req) } catch (err) { return cb(err) }
      try {
        json(res, 200, await tool.handler(body ?? {}, { sessionId: 'stdio' }))
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything below is inside start() DELIBERATELY — importing this module must
 * have no side effects. buildDevHandlers() constructs a whole McpServer (19 tool
 * registrations), so at module scope every test that imports this file would pay
 * for it at import time and could not choose a port.
 *
 * `port: 0` asks the OS for a free port — that is how a test avoids colliding
 * with a running dev server.
 */
export function start ({ port = SERVER_PORT } = {}) {
  const router = buildRouter({
    health: (_req, res) => json(res, 200, {
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      active_sessions: transports.size
    }),
    mcp: { post: mcpPost, get: mcpGet, del: mcpDelete },
    dev: buildDevHandlers()
  })

  const httpServer = http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[HTTP]   Port ${port} in use — aborting.`)
    } else {
      console.error('[HTTP]   Server error:', err.message)
    }
    process.exit(1)
  })

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const actual = httpServer.address().port
      console.error(`[HTTP]   Listening on :${actual}`)
      console.error('[HTTP]   /health, /login, /mcp')
      console.error('[MCP]    HTTP transport ready')
      resolve({ server: httpServer, port: actual })
    })
  })
}

await start()
