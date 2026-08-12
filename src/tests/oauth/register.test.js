import test from 'ava'
import request from 'supertest'
import express from 'express'
import { oauthRegisterRouter } from '../../routes/oauthRegister.js'

{ // POST /oauth/register
  const app = express()
  app.use(express.json())
  app.use('/oauth', oauthRegisterRouter)

  test('POST /oauth/register > registers a client', async t => {
    const res = await request(app).post('/oauth/register').send({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude'
    })
    t.is(res.status, 201)
    t.regex(res.body.client_id, /^[a-f0-9]{32}$/)
    t.deepEqual(res.body.redirect_uris, ['https://claude.ai/api/mcp/auth_callback'])
  })

  test('POST /oauth/register > rejects missing redirect_uris', async t => {
    const res = await request(app).post('/oauth/register').send({})
    t.is(res.status, 400)
    t.is(res.body.error, 'invalid_redirect_uri')
  })
}
