/**
 * http/request.js — the Express `req.query` / `req.header` / `req.ip` /
 * `express.json()` replacements, over a bare Node IncomingMessage.
 *
 * BODY SIZE LIMIT is a trust boundary, not a nicety: without it an unauthenticated
 * POST can buffer unbounded memory into a single-instance process. Enforced while
 * streaming, matching express.json()'s 100kb default (pinned by the contract suite).
 */

const MAX_BODY_BYTES = 100 * 1024

// Number of reverse-proxy hops we trust, and therefore how far to look back in
// X-Forwarded-For. Reproduces the Express setting it replaces —
// `app.set('trust proxy', 1)` — under which req.ip is the LAST XFF entry
// (proxy-addr trusts the hop closest to the app and returns the first untrusted
// address).
//
// SET IT TO 0 IF NOTHING TRUSTED SITS IN FRONT. XFF is client-supplied unless a
// proxy overwrites it, and clientIp() now keys the /mcp flood limiter and the
// brute-force guard on POST /api/login. Measured against a server reachable
// directly: a caller rotating the header took 700/700 where the cap was 600, and
// 0/40 blocked on the credential endpoint. Both deployments do front the app
// (GAE's load balancer, Coolify's Traefik) and both overwrite XFF, which is why
// the default stays 1 — but a deployment that exposes the process directly MUST
// set TRUSTED_PROXY_HOPS=0, or its rate limits are decorative.
//
// The opposite error is just as real and still unmeasured: if MORE than this many
// proxies sit in front, every caller collapses into one bucket.
// docs/superpowers/plans/phase0-findings.md records the XFF split as never run.
// Change this and the clientIp tests together, never one alone.
const TRUSTED_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1))

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

/**
 * The caller's address, used as a rate-limit bucket key — see TRUSTED_HOPS above
 * for why that makes this a trust boundary rather than a logging convenience.
 *
 * With TRUSTED_PROXY_HOPS=0 the header is ignored entirely and the socket address
 * is used, which a client cannot choose.
 */
export function clientIp (req) {
  const socketAddress = req.socket?.remoteAddress ?? 'unknown'
  // Belt-and-braces, not load-bearing: with TRUSTED_HOPS === 0 the index below is
  // hops.length, which is always out of range, so the fall-through already returns
  // the socket address. Kept because this is a trust boundary and the intent
  // should not depend on index arithmetic — but deleting it changes no behaviour,
  // which is why no test kills it.
  if (TRUSTED_HOPS === 0) return socketAddress

  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
    const idx = hops.length - TRUSTED_HOPS
    if (idx >= 0 && hops[idx]) return hops[idx]
  }
  return socketAddress
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
