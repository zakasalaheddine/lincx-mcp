import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import { query, header, clientIp, readBody } from '../../http/request.js'

function serve (handler) { return http.createServer(handler) }

/** Read the body, answering with it or with the error's status code. */
function bodyEcho () {
  return serve(async (req, res) => {
    try {
      const body = await readBody(req)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    } catch (err) {
      res.writeHead(err.statusCode ?? 500).end(String(err.statusCode))
    }
  })
}

test('query > parses the search string', async t => {
  const app = serve((req, res) => {
    const q = query(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ req: q.get('req'), missing: q.get('nope') }))
  })
  const r = await request(app).get('/login?req=abc123&x=1')
  t.is(r.body.req, 'abc123')
  t.is(r.body.missing, null)
})

test('query > empty when there is no search string', async t => {
  const app = serve((req, res) => {
    res.writeHead(200).end(String(query(req).get('a')))
  })
  const r = await request(app).get('/login')
  t.is(r.text, 'null')
})

test('header > is case-insensitive and returns undefined when absent', async t => {
  const app = serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      auth: header(req, 'Authorization') ?? null,
      sid: header(req, 'MCP-Session-Id') ?? null,
      none: header(req, 'x-nope') ?? null
    }))
  })
  const r = await request(app).get('/').set('authorization', 'Bearer x').set('mcp-session-id', 's1')
  t.is(r.body.auth, 'Bearer x')
  t.is(r.body.sid, 's1')
  t.is(r.body.none, null)
})

test('clientIp > takes the trusted hop from X-Forwarded-For', async t => {
  const app = serve((req, res) => res.writeHead(200).end(clientIp(req)))
  const r = await request(app).get('/').set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
  // One trusted proxy hop — the same as the `trust proxy: 1` this replaces — so
  // the client is the LAST entry. If the Phase 0 GAE spike shows a different hop
  // count, TRUSTED_HOPS and this expectation change together.
  t.is(r.text, '10.0.0.1')
})

test('clientIp > falls back to the socket address with no XFF', async t => {
  const app = serve((req, res) => res.writeHead(200).end(clientIp(req)))
  const r = await request(app).get('/')
  t.true(r.text.length > 0)
})

test('readBody > parses application/json', async t => {
  const r = await request(bodyEcho()).post('/').send({ a: 1, b: 'x' })
  t.deepEqual(r.body, { a: 1, b: 'x' })
})

test('readBody > parses application/x-www-form-urlencoded', async t => {
  const r = await request(bodyEcho()).post('/').type('form').send({ grant_type: 'refresh_token', client_id: 'c' })
  t.deepEqual(r.body, { grant_type: 'refresh_token', client_id: 'c' })
})

test('readBody > returns {} for an empty body', async t => {
  const r = await request(bodyEcho()).post('/').set('Content-Type', 'application/json').send('')
  t.deepEqual(r.body, {})
})

test('readBody > throws 400 on malformed JSON', async t => {
  const r = await request(bodyEcho()).post('/').set('Content-Type', 'application/json').send('{not json')
  t.is(r.status, 400)
})

test('readBody > throws 413 above the 100kb limit', async t => {
  const big = JSON.stringify({ x: 'y'.repeat(200_000) })
  const r = await request(bodyEcho()).post('/').set('Content-Type', 'application/json').send(big)
  t.is(r.status, 413)
})

test('readBody > stops reading once the limit is exceeded', async t => {
  // The limit must be enforced WHILE streaming, not after buffering the whole
  // payload — that is the actual trust boundary, since an unauthenticated POST
  // otherwise pins arbitrary memory in a single-instance process. `read` counts
  // the bytes the server actually pulled off the socket.
  let read = 0
  let status = 0
  const app = serve(async (req, res) => {
    req.on('data', (chunk) => { read += chunk.length })
    try {
      await readBody(req)
      res.writeHead(200).end('unreachable')
    } catch (err) {
      status = err.statusCode
      res.writeHead(err.statusCode ?? 500).end(String(err.statusCode))
    }
  })

  // The client is still uploading when the 413 goes out, so its own write can
  // fail with EPIPE/ECONNRESET — as it does against express.json() too. The
  // assertion is about what the SERVER did, not what the client saw.
  await request(app)
    .post('/')
    .set('Content-Type', 'application/json')
    .send('x'.repeat(5_000_000))
    .catch(() => {})

  t.is(status, 413)
  t.true(read < 5_000_000, `server read ${read} bytes of a 5MB body`)
})

test('readBody > treats an unknown content-type as empty', async t => {
  const r = await request(bodyEcho()).post('/').set('Content-Type', 'text/plain').send('hello')
  t.deepEqual(r.body, {})
})
