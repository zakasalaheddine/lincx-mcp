/**
 * tests/contract/buildApp.js
 *
 * The ONE place the contract suite knows how the HTTP surface is assembled.
 *
 * This exists so that http.test.js can stay byte-identical across the stack
 * migration: Phase 3 (express -> http-hash-router, #67) rewrote this file's body
 * to build the new listener, and the contract assertions did not move. That is
 * what makes the router swap verifiable rather than hopeful.
 *
 * It mirrors src/index.js's assembly for every route EXCEPT /mcp and /dev/*.
 * /mcp is excluded on purpose — it needs live transports and is covered by the
 * MCP protocol test (#69); everything here is the stateless surface.
 */

import http from 'node:http'
import { buildRouter, onRouterError } from '../../http/router.js'
import { json } from '../../http/respond.js'

export function buildContractApp () {
  const router = buildRouter({
    health: (_req, res) => json(res, 200, {
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      active_sessions: 0
    })
  })

  return http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })
}
