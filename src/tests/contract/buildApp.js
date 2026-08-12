/**
 * tests/contract/buildApp.js
 *
 * The ONE place the contract suite knows how the HTTP surface is assembled.
 *
 * This exists so that http.test.js can stay byte-identical across the stack
 * migration: Phase 3 (express -> http-hash-router, #67) rewrites this file's
 * body to build the new listener, and the contract assertions do not move. That
 * is what makes the router swap verifiable rather than hopeful.
 *
 * It mirrors src/index.js's assembly for every route EXCEPT /mcp and /dev/*.
 * /mcp is excluded on purpose — it needs live transports and is covered by the
 * MCP protocol test (#69); everything here is the stateless surface.
 */

import express from 'express'
import { wellKnownRouter } from '../../routes/wellKnown.js'
import { oauthRegisterRouter } from '../../routes/oauthRegister.js'
import { oauthTokenRouter } from '../../routes/oauthToken.js'
import { statsRouter } from '../../routes/stats.js'
import { loginRouter } from '../../routes/login.js'

export function buildContractApp () {
  const app = express()
  app.set('trust proxy', 1)
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      active_sessions: 0
    })
  })

  app.use('/.well-known', wellKnownRouter)
  app.use('/oauth', oauthRegisterRouter)
  app.use('/oauth', oauthTokenRouter)
  app.use(statsRouter)
  app.use(loginRouter)

  return app
}
