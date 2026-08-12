import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import { createLimiter } from '../middleware/rateLimit.js'

function serve (limiter) {
  return http.createServer((req, res) => {
    if (!limiter(req, res)) return
    res.writeHead(200).end('ok')
  })
}

test.serial('allows requests under the limit', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 3, keyOf: () => 'k1' })
  const app = serve(limiter)
  for (let i = 0; i < 3; i++) {
    const r = await request(app).get('/')
    t.is(r.status, 200)
  }
})

test.serial('429s past the limit with a JSON message', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 2, keyOf: () => 'k2', message: { error: 'slow down' } })
  const app = serve(limiter)
  await request(app).get('/')
  await request(app).get('/')
  const r = await request(app).get('/')
  t.is(r.status, 429)
  t.is(r.body.error, 'slow down')
})

test.serial('emits the draft-7 combined headers express-rate-limit sent', async t => {
  // Measured against the running Express server before the swap:
  //   RateLimit-Policy: 120;w=60
  //   RateLimit: limit=120, remaining=119, reset=60
  const limiter = createLimiter({ windowMs: 60_000, limit: 5, keyOf: () => 'k3' })
  const r = await request(serve(limiter)).get('/')
  t.is(r.headers['ratelimit-policy'], '5;w=60')
  t.is(r.headers.ratelimit, 'limit=5, remaining=4, reset=60')
  // draft-6's split headers were never sent by this server.
  t.is(r.headers['ratelimit-limit'], undefined)
})

test.serial('sets Retry-After on a 429', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 1, keyOf: () => 'k4' })
  const app = serve(limiter)
  await request(app).get('/')
  const r = await request(app).get('/')
  t.is(r.status, 429)
  t.truthy(r.headers['retry-after'])
})

test.serial('counts keys independently', async t => {
  let n = 0
  const limiter = createLimiter({ windowMs: 60_000, limit: 1, keyOf: () => `key-${n}` })
  const app = serve(limiter)
  n = 1; t.is((await request(app).get('/')).status, 200)
  n = 2; t.is((await request(app).get('/')).status, 200)
  n = 1; t.is((await request(app).get('/')).status, 429)
})

test.serial('resets after the window elapses', async t => {
  const limiter = createLimiter({ windowMs: 30, limit: 1, keyOf: () => 'k6' })
  const app = serve(limiter)
  t.is((await request(app).get('/')).status, 200)
  t.is((await request(app).get('/')).status, 429)
  await new Promise((resolve) => setTimeout(resolve, 45))
  t.is((await request(app).get('/')).status, 200)
})

test.serial('evicts expired keys so the Map cannot grow unbounded', async t => {
  const limiter = createLimiter({ windowMs: 20, limit: 100, keyOf: (req) => req.headers['x-key'] })
  const app = serve(limiter)
  for (let i = 0; i < 50; i++) await request(app).get('/').set('x-key', `k${i}`)
  await new Promise((resolve) => setTimeout(resolve, 40))
  await request(app).get('/').set('x-key', 'trigger-sweep')
  t.true(limiter.size() <= 1, `expected the window sweep to evict; size=${limiter.size()}`)
})
