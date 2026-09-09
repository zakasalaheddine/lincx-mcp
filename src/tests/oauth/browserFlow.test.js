/* eslint-disable camelcase -- OAuth params are snake_case on the wire: protocol, not style. */
import test from 'ava'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'

// Full end-to-end OAuth flow driven through a REAL browser (Puppeteer):
//
//   unauth POST /mcp
//     → 401 + RFC-9728 WWW-Authenticate challenge
//     → fetch protected-resource metadata → authorization-server metadata
//     → dynamic client registration (DCR)
//     → Puppeteer opens the authorize URL, follows the 302 to /login,
//       types email + password into the real login form, submits
//     → browser lands on the redirect_uri with ?code=&state=
//     → code exchanged for a wrapped access token (no refresh tokens)
//     → the access token is used as a Bearer on POST /mcp → 200 (initialize)
//
// The only two outbound seams that leave the process are the identity server
// (loginWithCredentials → POST IDENTITY_SERVER/auth/login) and the Work API
// networks endpoint (fetchUserNetworks → GET WORK_API_BASE_URL/api/networks).
// Both go through Node's global fetch, so a single globalThis.fetch stub covers
// them — exactly like oauth/flow.test.js. The browser's own fetch (the login
// form posting to /api/login) runs in the Chromium context and hits the real
// test server over HTTP, which is the whole point of this test.

// ── Pick a free port BEFORE importing the server ─────────────────────────────
// constants.js reads process.env at module scope (PORT, PUBLIC_BASE_URL,
// WRAPPING_KEY), and the OAuth discovery documents are built from PUBLIC_BASE_URL.
// For the challenge → discovery → DCR chain to resolve against the actual test
// server, PUBLIC_BASE_URL must equal the origin the server binds. So we reserve
// a port, set the env, then dynamically import server.js.
function getFreePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

const PORT = await getFreePort()
const ORIGIN = `http://127.0.0.1:${PORT}`
process.env.PORT = String(PORT)
process.env.PUBLIC_BASE_URL = ORIGIN
process.env.WRAPPING_KEY = process.env.WRAPPING_KEY || 'test-wrapping-key-32chars-minimum!!'

// ── Stub the two outbound seams (identity server + Work API networks) ────────
const realFetch = globalThis.fetch

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url)

  // Pass through calls to the test server itself (the test's own fetches to
  // /mcp, /.well-known/*, /oauth/*, and the browser's POST /api/login all hit
  // 127.0.0.1:<PORT> and must reach the real HTTP listener).
  if (u.startsWith(ORIGIN)) return realFetch(url, opts)

  const method = (opts.method ?? 'GET').toUpperCase()

  // loginWithCredentials → POST <IDENTITY_SERVER>/auth/login
  if (method === 'POST' && u.endsWith('/auth/login')) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const token = `${b64({ alg: 'none' })}.${b64({
      sub: 'u@x.com',
      email: 'u@x.com',
      exp: Math.floor(Date.now() / 1000) + 3600
    })}.sig`
    return jsonResponse({ success: true, data: { authToken: token } })
  }

  // fetchUserNetworks → GET <WORK_API_BASE_URL>/api/networks
  if (method === 'GET' && u.includes('/api/networks')) {
    return jsonResponse({
      data: [{
        id: 'svce6t',
        name: 'Test Net',
        owner: 'u',
        members: [],
        observers: [],
        dateCreated: '',
        dateUpdated: '',
        userUpdated: '',
        customDimensions: []
      }]
    })
  }

  throw new Error(`unexpected outbound fetch in browserFlow.test.js: ${method} ${u}`)
}

test.after.always(() => { globalThis.fetch = realFetch })

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ── Dynamic import AFTER env is set ───────────────────────────────────────────
const { start } = await import('../../server.js')
const puppeteer = await import('puppeteer')

const closeServer = (server) => new Promise((resolve) => server.close(resolve))

// ── The flow ──────────────────────────────────────────────────────────────────
test.serial('browser OAuth flow > unauth /mcp → 401 challenge → discovery → DCR → Puppeteer login → token → authenticated /mcp', async t => {
  // Puppeteer launches Chromium; give the whole flow headroom beyond ava's 30s.
  t.timeout(90_000)

  const { server, port } = await start({ port: PORT })
  const base = `http://127.0.0.1:${port}`
  t.is(port, PORT, 'server bound the reserved port')

  // Puppeteer resolves the Chrome build it downloaded at postinstall; if it is
  // missing this throws a clear "npx puppeteer browsers install chrome" error.
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  try {
    // 1. Unauthenticated agent hits /mcp → 401 + RFC-9728 challenge.
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    })
    t.is(unauth.status, 401)
    const wwwAuth = unauth.headers.get('www-authenticate') ?? ''
    t.regex(wwwAuth, /^Bearer resource_metadata="/)
    const resourceMetaMatch = wwwAuth.match(/resource_metadata="([^"]+)"/)
    t.truthy(resourceMetaMatch)

    // 2. Fetch the protected-resource metadata (RFC 9728).
    const resourceMetaRes = await fetch(resourceMetaMatch[1])
    t.is(resourceMetaRes.status, 200)
    const resourceMeta = await resourceMetaRes.json()
    t.is(resourceMeta.resource, `${base}/mcp`)
    t.true(Array.isArray(resourceMeta.authorization_servers))

    // 3. Fetch the authorization-server metadata.
    const authServerUrl = resourceMeta.authorization_servers[0] + '/.well-known/oauth-authorization-server'
    const authMetaRes = await fetch(authServerUrl)
    t.is(authMetaRes.status, 200)
    const authMeta = await authMetaRes.json()
    t.is(authMeta.authorization_endpoint, `${base}/oauth/authorize`)
    t.is(authMeta.token_endpoint, `${base}/oauth/token`)
    t.is(authMeta.registration_endpoint, `${base}/oauth/register`)
    t.true(authMeta.code_challenge_methods_supported.includes('S256'))

    // 4. Dynamic client registration.
    const redirectUri = `${base}/login/success`
    const regRes = await fetch(authMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: 'puppeteer-test' })
    })
    t.is(regRes.status, 201)
    const reg = await regRes.json()
    const client_id = reg.client_id
    t.truthy(client_id)

    // 5. PKCE.
    const verifier = randomBytes(40).toString('base64url')
    const code_challenge = challenge(verifier)
    const state = randomBytes(8).toString('hex')

    // 6. Drive the browser through authorize → /login → submit creds.
    const page = await browser.newPage()
    // Block external font requests so the login page never waits on the network.
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (req.url().startsWith(base)) return req.continue()
      req.abort('blockedbyclient')
    })

    const authorizeUrl = new URL(authMeta.authorization_endpoint)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', client_id)
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', code_challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    await page.goto(authorizeUrl.toString(), { waitUntil: 'domcontentloaded' })

    // authorize 302s to /login?ctx=…; the form must be rendered.
    await page.waitForSelector('#email', { timeout: 10_000 })
    t.is(new URL(page.url()).pathname, '/login', 'authorize redirected to the login page')

    await page.type('#email', 'u@x.com')
    await page.type('#password', 'pw')

    // Submit and wait for the browser to land on the redirect_uri with the code.
    await Promise.all([
      page.waitForFunction(
        () => window.location.pathname === '/login/success',
        { timeout: 15_000 }
      ),
      page.click('#btn')
    ])

    const finalUrl = new URL(page.url())
    const code = finalUrl.searchParams.get('code')
    t.truthy(code, 'redirect_uri carried an auth code')
    t.is(finalUrl.searchParams.get('state'), state, 'state echoed back unchanged')
    await page.close()

    // 7. Exchange the code for tokens (PKCE verified server-side).
    const tokRes = await fetch(authMeta.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id,
        code_verifier: verifier
      })
    })
    t.is(tokRes.status, 200)
    const tokens = await tokRes.json()
    t.is(tokens.token_type, 'Bearer')
    t.truthy(tokens.access_token)
    t.falsy(tokens.refresh_token)

    // 8. The bearer now authenticates against /mcp — initialize succeeds.
    const authed = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.access_token}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'puppeteer-flow', version: '1.0.0' }
        }
      })
    })
    t.is(authed.status, 200)
    const authedBody = await authed.json()
    t.falsy(authedBody.error, 'no JSON-RPC error on an authenticated initialize')
    t.truthy(authedBody.result, 'initialize returned a result')
    t.is(authedBody.result.protocolVersion, '2025-06-18')
  } finally {
    await browser.close().catch(() => {})
    await closeServer(server)
  }
})
