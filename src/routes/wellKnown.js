import { buildAuthServerMetadata, buildResourceMetadata } from '../services/oauth/metadata.js'
import { PUBLIC_BASE_URL } from '../constants.js'
import { json } from '../http/respond.js'

export function authServerMetadata (_req, res) {
  json(res, 200, buildAuthServerMetadata(PUBLIC_BASE_URL))
}

// RFC 9728 §3.1: the well-known URI is the suffix "oauth-protected-resource"
// prefixed onto the resource path. Our resource is "<base>/mcp", so spec-
// conformant clients construct "<base>/.well-known/oauth-protected-resource/mcp"
// and ignore the root form. Both paths are registered in the route table —
// http-hash matches exact pathnames, so there is no array-path form here.
export function resourceMetadata (_req, res) {
  json(res, 200, buildResourceMetadata(PUBLIC_BASE_URL))
}
