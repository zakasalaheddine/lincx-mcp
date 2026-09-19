/**
 * server.js — the Lincx MCP server itself.
 *
 * src/index.js is the bootstrap; it calls start(). Importing this file has no
 * side effects — start() does all the work. constants.js reads process.env at
 * module scope, so the environment must be populated before this is imported.
 *
 * Two surfaces on one bare Node HTTP server:
 *  1. HTTP login UI (GET /login, POST /api/login, GET /login/success)
 *  2. MCP Streamable HTTP transport (POST /mcp)
 *
 * The server is HTTP-only — MCP clients connect over /mcp. There is no stdio
 * transport; everything (Claude Code, Desktop, claude.ai) connects by URL.
 *
 * The transport is STATELESS: no `sessionIdGenerator`, no in-process session
 * map, nothing to lose on restart. Identity comes from the OAuth bearer on each
 * request, which resolves to a Lincx session in Redis. That is what lets the
 * service run more than one instance and deploy without dropping clients.
 */

import http from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'

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
import { registerAuditTools } from './tools/auditTools.js'
import { registerZoneInventoryTools } from './tools/zoneInventoryTools.js'
import { registerZoneEligibilityTools } from './tools/zoneEligibilityTools.js'
import { registerAnalysisTools } from './tools/analysisTools.js'
import { registerResources } from './tools/resources.js'
import { installToolGuards } from './middleware/toolGuard.js'
import { mcpIpLimiter, mcpUserLimiter, userKey } from './middleware/rateLimit.js'
import { SERVER_PORT, IS_PRODUCTION, PUBLIC_BASE_URL, MCP_MAX_BATCH } from './constants.js'
import { resolveLincxSessionFromBearer, resolveUserBucket } from './services/sessionManager.js'
import { assertWrappingKey } from './services/tokenService.js'
import { buildRouter, onRouterError } from './http/router.js'
import { buildHealthHandler } from './http/health.js'
import { json } from './http/respond.js'
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
  registerAuditTools(server)
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)
  registerAnalysisTools(server)
  registerResources(server)

  // Wrap every registered tool handler with the response-size guard + metrics
  // logging. Must run after all register*Tools() calls above.
  installToolGuards(server)

  return server
}

// ── MCP HTTP transport — stateless, one per request ─────────────────────────

/**
 * A fresh transport + server for a single request, then discarded.
 *
 * `sessionIdGenerator: undefined` is what makes the transport stateless. The SDK
 * then refuses to handle a second request on the same transport (message-id
 * collisions between clients), so this must NOT be hoisted or cached.
 */
async function createTransport () {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  })
  // A dedicated server instance per transport — see createMcpServer().
  const mcpServer = createMcpServer()
  try {
    await mcpServer.connect(transport)
  } catch (err) {
    await transport.close().catch(() => {})
    throw err
  }
  return { transport, mcpServer }
}

function bearerChallengeHeader () {
  return `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`
}

/**
 * 401 + the RFC-9728 challenge that starts the OAuth discovery dance.
 *
 * The body-less variant went with GET/DELETE — POST is the only method left on
 * /mcp, and it always answered with a body.
 */
function unauthorized (res) {
  res.setHeader('WWW-Authenticate', bearerChallengeHeader())
  json(res, 401, { error: 'unauthorized', error_description: 'Bearer token required.' })
}

async function mcpPost (req, res, _opts, cb) {
  // Tier 1, pre-auth: bounds the work an unauthenticated caller can force
  // (readBody below, then a Redis lookup). Keyed by address — see clientIp() in
  // http/request.js for why that is only sound behind a trusted proxy, and
  // middleware/rateLimit.js for why one tier is not enough.
  //
  // The challenge header goes on FIRST, so a 429 here still points a new client at
  // OAuth discovery. CLAUDE.md § Deployment makes that a hard rule — it is why a
  // query-param access gate was rejected — and a bare 429 on the one endpoint that
  // advertises `resource_metadata` is the same failure: a fresh connector behind a
  // busy shared egress could never learn where to authenticate.
  res.setHeader('WWW-Authenticate', bearerChallengeHeader())
  if (!mcpIpLimiter(req, res)) return

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
    // Identity is the bearer, and nothing else: no session id is minted, sent or
    // read. A client's `mcp-session-id` header (if it still sends one from a
    // previous stateful connection) is simply ignored — which is exactly why a
    // restart no longer forces a re-initialize.
    const auth = await resolveLincxSessionFromBearer(header(req, 'authorization'))
    if (!auth) return unauthorized(res)

    // One POST can carry a JSON-RPC ARRAY, and the transport runs every message
    // in it. Cap the length and charge the budget per message, or 120 req/min is
    // 120 000 tool calls/min.
    const messages = Array.isArray(body) ? body.length : 1
    if (messages > MCP_MAX_BATCH) {
      return json(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32600,
          message: `Batch too large: ${messages} messages (max ${MCP_MAX_BATCH}). Split the batch.`
        }
      })
    }

    // Tier 2, post-auth: the real fairness control, keyed on the caller's IDENTITY
    // rather than on anything they send. Not the raw header — `Bearer x` and
    // `bearer  x` authenticate as the same user, so hashing the header would hand
    // one user several buckets. Bucket is the Lincx JWT `sub` (via resolveUserBucket).
    const bucket = userKey(resolveUserBucket(auth))
    if (!mcpUserLimiter(req, res, bucket, messages)) {
      // Hand back the tier-1 slot this request already spent. Otherwise a single
      // user hitting their own cap burns the address budget everyone behind the
      // same egress shares.
      mcpIpLimiter.refund(req, undefined, 1)
      return
    }

    const { transport, mcpServer } = await createTransport()

    // Nothing outlives the request — without this, every call leaks a transport
    // and a fully-registered McpServer.
    //
    // 'close', not 'finish': an aborted request never finishes, and a cancelled
    // long-running tool call is exactly when a leak matters most.
    //
    // The `res.destroyed` check closes the window this listener cannot cover.
    // createTransport() is awaited, so a client that gives up DURING it has
    // already fired 'close' by the time we get here — the listener would be
    // attached to a dead response and never run. Measured: 4 transports built,
    // 3 disposed.
    const dispose = () => {
      transport.close().catch(() => {})
      mcpServer.close().catch(() => {})
    }
    if (res.destroyed) return dispose()
    res.on('close', dispose)

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

// There is no GET or DELETE on /mcp, so the router answers 405 for both.
//
// GET only ever served the standalone SSE stream, which stateless mode cannot
// hold open; `enableJsonResponse: true` means POST answers with JSON.
//
// DELETE is the client's "end this session" call, and 405 is the spec's answer
// for a server that does not let clients terminate sessions — which is now
// literally true, there is no session to end. An earlier version of this branch
// answered 200, which is worse than either: a success status on a security
// operation that revoked nothing, while the OAuth access token and the Lincx
// session both stayed valid. Logging out is `auth_logout`.

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
        const extra = { requestInfo: { headers: { authorization: header(req, 'authorization') } } }
        json(res, 200, await tool.handler(body ?? {}, extra))
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
  // Fail before bind when the wrapping key is missing/short — every OAuth and
  // access-token path needs it, and a half-started instance with no key is worse
  // than a refuse-to-boot.
  assertWrappingKey()

  const router = buildRouter({
    health: buildHealthHandler(),
    mcp: { post: mcpPost },
    dev: buildDevHandlers()
  })

  const httpServer = http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })

  // Bind failure REJECTS rather than calling process.exit: a test that binds an
  // explicit port and loses the race to a concurrently-running test file would
  // otherwise take the whole ava worker down with no assertion message.
  // src/index.js turns that rejection back into the exit(1) production wants.
  //
  // AFTER listen resolves, a rejection would be a no-op on a settled promise — so
  // a fatal server error would be logged and then silently ignored, leaving a
  // broken instance the platform never restarts. Past that point the only correct
  // response is still to exit.
  return new Promise((resolve, reject) => {
    let listening = false

    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[HTTP]   Port ${port} in use — aborting.`)
      } else {
        console.error('[HTTP]   Server error:', err.message)
      }
      if (listening) process.exit(1)
      reject(err)
    })

    httpServer.listen(port, () => {
      listening = true
      const actual = httpServer.address().port
      console.error(`[HTTP]   Listening on :${actual}`)
      console.error('[HTTP]   /health, /login, /mcp')
      console.error('[MCP]    HTTP transport ready')
      resolve({ server: httpServer, port: actual })
    })
  })
}
