/**
 * http/request.js — the Express `req.query` / `req.header` / `req.ip` /
 * `express.json()` replacements, over a bare Node IncomingMessage.
 *
 * BODY SIZE LIMIT is a trust boundary, not a nicety: without it an unauthenticated
 * POST can buffer unbounded memory into a single-instance process. Enforced while
 * streaming, matching express.json()'s 100kb default (pinned by the contract suite).
 */

const MAX_BODY_BYTES = 100 * 1024

// Number of reverse-proxy hops we trust. This reproduces the Express setting it
// replaces — `app.set('trust proxy', 1)`, exactly one hop — under which req.ip is
// the LAST X-Forwarded-For entry (proxy-addr trusts the hop closest to the app and
// returns the first untrusted address). The Phase 0 GAE spike may show a different
// hop count in front of App Engine; if it does, change this and the clientIp test
// together, never one alone.
const TRUSTED_HOPS = 1

export class BodyError extends Error {
  constructor (message, statusCode) {
    super(message)
    this.name = 'BodyError'
    this.statusCode = statusCode
  }
}

export function query (req) {
  return new URL(req.url, 'http://localhost').searchParams
}

export function header (req, name) {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

export function clientIp (req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
    const idx = hops.length - TRUSTED_HOPS
    if (idx >= 0 && hops[idx]) return hops[idx]
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

export async function readBody (req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim()
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
    return {}
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    // Checked per chunk, before appending: the point is never to hold more than
    // the limit in memory, not to report afterwards that we did.
    if (size > MAX_BODY_BYTES) {
      // Stop consuming but leave the socket alive — express.json()/raw-body
      // unpipe and pause here too. Destroying it instead resets the connection
      // before the 413 can be written, and the client sees ECONNRESET rather
      // than the status code the contract suite pins.
      req.unpipe?.()
      req.pause()
      throw new BodyError('request entity too large', 413)
    }
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}

  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      throw new BodyError('invalid JSON body', 400)
    }
  }

  return Object.fromEntries(new URLSearchParams(raw))
}
