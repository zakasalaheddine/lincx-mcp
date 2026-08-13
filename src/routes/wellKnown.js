import { buildAuthServerMetadata, buildResourceMetadata } from '../services/oauth/metadata.js'
import { PUBLIC_BASE_URL } from '../constants.js'
import { json } from '../http/respond.js'
import { header } from '../http/request.js'

// Every endpoint in these documents is built from PUBLIC_BASE_URL. If the server is
// reached on some OTHER origin — a tunnel, a proxy, a renamed domain — the client
// fetches discovery over https and then reads a registration_endpoint on
// http://localhost, refuses it, and reports only "Couldn't register with the
// sign-in service". Nothing on this side fails, which is what makes it expensive to
// diagnose. So say it out loud, once per offending host.
const warnedHosts = new Set()

function warnOnHostMismatch (req) {
  const host = header(req, 'x-forwarded-host') ?? header(req, 'host')
  if (!host || warnedHosts.has(host)) return
  let expected
  try {
    expected = new URL(PUBLIC_BASE_URL).host
  } catch {
    return
  }
  if (host === expected) return
  warnedHosts.add(host)
  console.error(
    `[OAuth] discovery served for host "${host}" but PUBLIC_BASE_URL is ` +
    `"${PUBLIC_BASE_URL}" — clients will read every endpoint on the wrong origin ` +
    'and dynamic client registration will fail. Set PUBLIC_BASE_URL to the URL ' +
    'clients actually hit (npm run dev does this automatically for a tunnel).'
  )
}

export function authServerMetadata (req, res) {
  warnOnHostMismatch(req)
  json(res, 200, buildAuthServerMetadata(PUBLIC_BASE_URL))
}

// RFC 9728 §3.1: the well-known URI is the suffix "oauth-protected-resource"
// prefixed onto the resource path. Our resource is "<base>/mcp", so spec-
// conformant clients construct "<base>/.well-known/oauth-protected-resource/mcp"
// and ignore the root form. Both paths are registered in the route table —
// http-hash matches exact pathnames, so there is no array-path form here.
export function resourceMetadata (req, res) {
  warnOnHostMismatch(req)
  json(res, 200, buildResourceMetadata(PUBLIC_BASE_URL))
}
