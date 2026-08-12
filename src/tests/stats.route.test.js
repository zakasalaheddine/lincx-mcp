import test from 'ava'
import request from 'supertest'

// Set the token BEFORE importing constants/route (constants read env at load).
process.env.STATS_TOKEN = 'secret-xyz'

const { buildTestApp } = await import('./helpers/testApp.js')
const { statsRouter } = await import('../routes/stats.js')

function app () {
  const a = buildTestApp()
  a.use(statsRouter)
  return a
}

{ // GET /stats
  test('GET /stats > 401s without the right bearer token', async t => {
    const res = await request(app()).get('/stats')
    t.is(res.status, 401)
  })

  test('GET /stats > returns the stats payload with the right bearer token', async t => {
    const res = await request(app()).get('/stats').set('Authorization', 'Bearer secret-xyz')
    t.is(res.status, 200)
    t.true('window' in res.body)
    t.true('tools' in res.body)
    t.true('users' in res.body)
    t.true('errors' in res.body)
    t.true('sequences' in res.body)
  })

  test('GET /stats > accepts the token as a ?token= query param (browser-friendly)', async t => {
    const res = await request(app()).get('/stats?token=secret-xyz')
    t.is(res.status, 200)
    t.true('window' in res.body)
  })

  test('GET /stats > 401s on a wrong ?token= value', async t => {
    const res = await request(app()).get('/stats?token=nope')
    t.is(res.status, 401)
  })
}
