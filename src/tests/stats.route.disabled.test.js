import test from 'ava'
import request from 'supertest'

// Unset BEFORE importing constants/route (constants read env at load).
delete process.env.STATS_TOKEN

const { buildContractApp } = await import('./contract/buildApp.js')

// GET /stats when STATS_TOKEN is unset
test('GET /stats when STATS_TOKEN is unset > 404s (endpoint disabled, never accidentally public)', async t => {
  const res = await request(buildContractApp()).get('/stats').set('Authorization', 'Bearer anything')
  t.is(res.status, 404)
})
