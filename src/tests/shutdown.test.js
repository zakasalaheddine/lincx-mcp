import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import esmock from 'esmock'
import { json } from '../http/respond.js'

/** The router with both store-close functions replaced by counters. */
async function appWithSpies () {
  const calls = []
  const { buildRouter, onRouterError } = await esmock('../http/router.js', {
    '../services/sessionStore.js': { closeKvStore: async () => calls.push('kv') },
    '../services/usageAnalytics.js': { closeEventSink: async () => calls.push('sink') }
  })
  const router = buildRouter({ health: (_req, res) => json(res, 200, { status: 'ok' }) })
  const server = http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })
  return { server, calls }
}

test('GET /_ah/stop closes the Redis connections and still answers 200', async t => {
  const { server, calls } = await appWithSpies()
  const r = await request(server).get('/_ah/stop')
  t.is(r.status, 200)
  t.deepEqual(calls.sort(), ['kv', 'sink'])
})

test('GET /_ah/stop answers 200 even when a close fails', async t => {
  // The instance is already going away; a failed close must not make it look
  // unhealthy on the way out.
  const { buildRouter, onRouterError } = await esmock('../http/router.js', {
    '../services/sessionStore.js': { closeKvStore: async () => { throw new Error('redis gone') } },
    '../services/usageAnalytics.js': { closeEventSink: async () => {} }
  })
  const router = buildRouter({ health: (_req, res) => json(res, 200, { status: 'ok' }) })
  const server = http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })
  const r = await request(server).get('/_ah/stop')
  t.is(r.status, 200)
})

test('GET /_ah/start and /_ah/warmup answer 200 without touching Redis', async t => {
  const { server, calls } = await appWithSpies()
  for (const path of ['/_ah/start', '/_ah/warmup']) {
    t.is((await request(server).get(path)).status, 200, path)
  }
  t.deepEqual(calls, [])
})
