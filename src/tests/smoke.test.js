import test from 'ava'
import request from 'supertest'
import { buildTestApp } from './helpers/testApp.js'
import { wellKnownRouter } from '../routes/wellKnown.js'

{ // smoke
  test('smoke > test harness boots', async t => {
    const app = buildTestApp()
    app.get('/ok', (_req, res) => {
      res.json({ ok: true })
    })
    const res = await request(app).get('/ok')
    t.is(res.status, 200)
    t.deepEqual(res.body, { ok: true })
  })

  test('smoke > serves authorization-server metadata', async t => {
    const app = buildTestApp()
    app.use('/.well-known', wellKnownRouter)
    const res = await request(app).get('/.well-known/oauth-authorization-server')
    t.is(res.status, 200)
    t.regex(res.body.token_endpoint, /\/oauth\/token$/)
    t.true(res.body.code_challenge_methods_supported.includes('S256'))
  })

  test('smoke > serves protected-resource metadata', async t => {
    const app = buildTestApp()
    app.use('/.well-known', wellKnownRouter)
    const res = await request(app).get('/.well-known/oauth-protected-resource')
    t.is(res.status, 200)
    t.regex(res.body.resource, /\/mcp$/)
    t.true(res.body.authorization_servers instanceof Array)
  })

  test('smoke > serves protected-resource metadata at the RFC 9728 path-scoped URL', async t => {
    const app = buildTestApp()
    app.use('/.well-known', wellKnownRouter)
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp')
    t.is(res.status, 200)
    t.regex(res.body.resource, /\/mcp$/)
    t.true(res.body.authorization_servers instanceof Array)
  })
}
