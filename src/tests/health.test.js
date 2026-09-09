/**
 * tests/health.test.js
 *
 * /health reports wrapping-key readiness and Work API base URL — no Redis.
 */

import test from 'ava'
import request from 'supertest'
import { judgeStatus } from '../http/health.js'
import { buildContractApp } from './contract/buildApp.js'

test('judgeStatus > wrapping key present is ok', t => {
  t.is(judgeStatus({ wrappingKeyOk: true }), 'ok')
})

test('judgeStatus > missing wrapping key is degraded', t => {
  t.is(judgeStatus({ wrappingKeyOk: false }), 'degraded')
})

test('/health > reports wrapping key and work api', async t => {
  const r = await request(buildContractApp()).get('/health')
  t.is(r.status, 200)
  t.is(r.body.status, 'ok')
  t.is(r.body.wrapping_key_ok, true)
  t.is(typeof r.body.work_api, 'string')
  t.is(typeof r.body.uptime_s, 'number')
})

test('/health > never leaks the wrapping key', async t => {
  const r = await request(buildContractApp()).get('/health')
  const body = JSON.stringify(r.body)
  t.false(body.includes('test-wrapping-key'))
  t.deepEqual(
    Object.keys(r.body).sort(),
    ['status', 'uptime_s', 'work_api', 'wrapping_key_ok'].sort()
  )
})
