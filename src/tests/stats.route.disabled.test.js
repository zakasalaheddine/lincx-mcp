import test from 'ava'
import request from 'supertest'

// Unset BEFORE importing constants/route (constants read env at load).
delete process.env.STATS_TOKEN

const { buildTestApp } = await import('./helpers/testApp.js')
const { statsRouter } = await import('../routes/stats.js')

{ // GET /stats when STATS_TOKEN is unset
  test('GET /stats when STATS_TOKEN is unset > 404s (endpoint disabled, never accidentally public)', async t => {
    const app = buildTestApp()
    app.use(statsRouter)
    const res = await request(app).get('/stats').set('Authorization', 'Bearer anything')
    t.is(res.status, 404)
  })
}
