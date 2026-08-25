/**
 * tests/health.test.js
 *
 * /health is what makes the deliberate fail-open in src/config/secrets.js
 * visible: a production instance that fell back to the in-memory session store
 * still boots and still serves, but logs every user out on each redeploy.
 *
 * The judgement lives in a pure function so all four environment/store
 * combinations are testable without a live Redis, and the HTTP test below runs
 * the SHIPPING handler through the contract harness.
 */

import test from 'ava'
import request from 'supertest'
import { judgeStatus } from '../http/health.js'
import { buildContractApp } from './contract/buildApp.js'

test('judgeStatus > in-memory store is ok outside production', t => {
  t.is(judgeStatus({ store: 'memory', redisOk: false, isProduction: false }), 'ok')
})

test('judgeStatus > reachable redis is ok in production', t => {
  t.is(judgeStatus({ store: 'redis', redisOk: true, isProduction: true }), 'ok')
})

test('judgeStatus > unreachable redis is degraded in production', t => {
  t.is(judgeStatus({ store: 'redis', redisOk: false, isProduction: true }), 'degraded')
})

test('judgeStatus > in-memory fallback is degraded in production', t => {
  t.is(judgeStatus({ store: 'memory', redisOk: false, isProduction: true }), 'degraded')
})

test('judgeStatus > a failed probe is degraded in production, ok in dev', t => {
  t.is(judgeStatus({ store: 'unknown', redisOk: false, isProduction: true }), 'degraded')
  t.is(judgeStatus({ store: 'unknown', redisOk: false, isProduction: false }), 'ok')
})

test('/health > reports the live store without a prior session', async t => {
  // ava sets REDIS_URL='' and NODE_ENV=test (see package.json), so this is the
  // dev/memory row. No login has happened — the store is lazy, and /health
  // establishing the answer itself is the point.
  const r = await request(buildContractApp()).get('/health')
  t.is(r.status, 200)
  t.is(r.body.status, 'ok')
  t.is(r.body.store, 'memory')
  t.is(r.body.redis_ok, false)
  t.is(typeof r.body.uptime_s, 'number')
})

test('/health > never leaks the connection string', async t => {
  const r = await request(buildContractApp()).get('/health')
  const body = JSON.stringify(r.body)
  t.false(body.includes('redis://'))
  t.deepEqual(
    Object.keys(r.body).sort(),
    ['redis_ok', 'status', 'store', 'uptime_s']
  )
})
