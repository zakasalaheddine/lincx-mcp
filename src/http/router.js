/**
 * http/router.js — the whole URL surface in one table.
 *
 * http-hash-router matches ONLY url.pathname; query strings, bodies and
 * middleware chains are handled explicitly by the helpers in ./request.js.
 * A `{ GET, POST }` object dispatches by method and returns 405 for anything
 * unlisted (Express fell through to 404 — the contract suite pins which).
 */

import HttpHashRouter from 'http-hash-router'
import { json, noContent } from './respond.js'
import { closeKvStore } from '../services/sessionStore.js'
import { closeEventSink } from '../services/usageAnalytics.js'
import { authServerMetadata, resourceMetadata } from '../routes/wellKnown.js'
import { postRegister } from '../routes/oauthRegister.js'
import { postToken } from '../routes/oauthToken.js'
import { getStats } from '../routes/stats.js'
import { getAuthorize, getLogin, postApiLogin, getLoginSuccess } from '../routes/login.js'

export function buildRouter ({ health, mcp, dev }) {
  const router = HttpHashRouter()

  router.set('/health', { GET: health })

  // GAE manual/basic scaling sends these; a non-200 means the instance never
  // becomes healthy and the deploy silently fails.
  router.set('/_ah/start', { GET: (_req, res) => noContent(res, 200) })
  router.set('/_ah/warmup', { GET: (_req, res) => noContent(res, 200) })

  // /_ah/stop precedes shutdown, so it is the one place a graceful Redis close
  // belongs. It answers 200 either way: a failed close must not make the instance
  // look unhealthy while it is already going away.
  router.set('/_ah/stop', {
    GET: async (_req, res) => {
      try {
        await Promise.all([closeKvStore(), closeEventSink()])
      } catch (err) {
        console.error('[HTTP]   /_ah/stop close failed:', err instanceof Error ? err.message : String(err))
      }
      noContent(res, 200)
    }
  })

  router.set('/.well-known/oauth-authorization-server', { GET: authServerMetadata })
  router.set('/.well-known/oauth-protected-resource', { GET: resourceMetadata })
  router.set('/.well-known/oauth-protected-resource/mcp', { GET: resourceMetadata })

  router.set('/oauth/register', { POST: postRegister })
  router.set('/oauth/token', { POST: postToken })
  router.set('/oauth/authorize', { GET: getAuthorize })

  router.set('/login', { GET: getLogin })
  router.set('/login/success', { GET: getLoginSuccess })
  router.set('/api/login', { POST: postApiLogin })

  router.set('/stats', { GET: getStats })

  if (mcp) {
    router.set('/mcp', { POST: mcp.post, GET: mcp.get, DELETE: mcp.del })
  }

  if (dev) {
    router.set('/dev/tools', { GET: dev.list })
    router.set('/dev/tools/:name', { POST: dev.call })
  }

  return router
}

export function onRouterError (err, _req, res) {
  if (!err) return
  if (res.headersSent) return

  const status = err.statusCode ?? 500
  if (status === 404) return json(res, 404, { error: 'not_found' })
  if (status === 405) return json(res, 405, { error: 'method_not_allowed' })
  if (status === 413) return json(res, 413, { error: 'payload_too_large' })
  if (status === 400) return json(res, 400, { error: 'bad_request' })

  console.error('[HTTP]   unhandled route error:', err instanceof Error ? err.message : String(err))
  json(res, 500, { error: 'internal_server_error' })
}
