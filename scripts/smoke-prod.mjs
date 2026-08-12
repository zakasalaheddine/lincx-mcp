#!/usr/bin/env node
/**
 * Post-deploy verification against a live URL.
 *   node scripts/smoke-prod.mjs https://mcp.lincx.com
 *
 * Read-only and unauthenticated: it never logs in and never sends a token, so it
 * is safe to run against production on every deploy. Exits non-zero on the first
 * failure count, so it can gate a pipeline.
 *
 * The check that earns this script's existence is the metadata one: a
 * PUBLIC_BASE_URL that does not match the URL clients actually hit breaks OAuth
 * with no useful client-side error, and nothing else notices.
 */

const base = (process.argv[2] ?? 'https://mcp.lincx.com').replace(/\/$/, '')
let failures = 0

async function check (name, fn) {
  try {
    await fn()
    console.error(`  PASS  ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  FAIL  ${name} — ${err.message}`)
  }
}

function assert (cond, msg) { if (!cond) throw new Error(msg) }

console.error(`Smoking ${base}`)

await check('/health returns ok', async () => {
  const r = await fetch(`${base}/health`)
  assert(r.status === 200, `status ${r.status}`)
  const b = await r.json()
  assert(b.status === 'ok', `status field ${b.status}`)
})

await check('POST /mcp challenges with RFC-9728', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert(r.status === 401, `status ${r.status}`)
  const wa = r.headers.get('www-authenticate') ?? ''
  assert(wa.startsWith('Bearer resource_metadata="'), `WWW-Authenticate: ${wa}`)
  assert(wa.includes(base), `challenge points elsewhere: ${wa}`)
})

await check('GET /mcp challenges with RFC-9728', async () => {
  const r = await fetch(`${base}/mcp`)
  assert(r.status === 401, `status ${r.status}`)
  assert((r.headers.get('www-authenticate') ?? '').startsWith('Bearer '), 'missing challenge')
})

await check('authorization-server metadata matches the public base URL', async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
  assert(r.status === 200, `status ${r.status}`)
  const b = await r.json()
  assert(b.issuer === base, `issuer ${b.issuer} != ${base} — PUBLIC_BASE_URL is wrong`)
  assert(b.authorization_endpoint === `${base}/oauth/authorize`, `authorization_endpoint ${b.authorization_endpoint}`)
  assert(b.token_endpoint === `${base}/oauth/token`, `token_endpoint ${b.token_endpoint}`)
})

await check('protected-resource metadata is served at both paths', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const r = await fetch(`${base}${p}`)
    assert(r.status === 200, `${p} → ${r.status}`)
    const b = await r.json()
    assert(b.resource === `${base}/mcp`, `${p} resource ${b.resource}`)
  }
})

await check('DCR issues a client_id', async () => {
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'smoke' })
  })
  assert(r.status === 201, `status ${r.status}`)
  const b = await r.json()
  assert(typeof b.client_id === 'string' && b.client_id.length > 0, 'no client_id')
})

await check('/stats is gated, not open', async () => {
  const r = await fetch(`${base}/stats`)
  // 401 = STATS_TOKEN is set and enforced. 404 = the token is unset, which is a
  // deliberate "fully disabled" state locally but means Secret Manager did not
  // resolve it in production — check `gcloud app logs | grep '[Secrets]'`.
  assert(r.status === 401 || r.status === 404, `status ${r.status} — /stats must never be 200 unauthenticated`)
})

await check('/_ah/start answers 200', async () => {
  const r = await fetch(`${base}/_ah/start`)
  assert(r.status === 200, `status ${r.status}`)
})

console.error(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
