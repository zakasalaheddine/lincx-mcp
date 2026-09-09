#!/usr/bin/env node
/**
 * Soak: poll an authenticated client for a requested duration and prove the
 * property the stateless transport exists to give — that RESTARTS AND EXTRA
 * INSTANCES ARE INVISIBLE to a connected client.
 *
 *   SOAK_TOKEN=<access_token> node scripts/soak.mjs https://mcp.lincx.com 3600
 *
 * This inverts the pre-stateless version of this script, which held one
 * mcp-session-id open and FAILED on an observed restart. There is no session to
 * hold any more: identity is the bearer, so the only thing that matters is that
 * every poll succeeds. Restarts are now reported as evidence, not as failure —
 * redeploy the service mid-run and the run should stay green.
 *
 * A 401 means the request was not authenticated. Because the wrapped access token
 * inherits the underlying Lincx JWT lifetime, a 401 before the requested duration
 * has elapsed is a genuine failure (premature expiry, a bad token, or an auth
 * regression). The caller is responsible for supplying a token that outlives the
 * soak; the script no longer treats 401 as an expected end-of-run event.
 *
 * The token comes from the environment, never argv: a CLI argument lands in shell
 * history and in `ps` output. Take it from your MCP client's stored credentials
 * after a normal browser login.
 */

const [base, secondsArg] = process.argv.slice(2)
const token = process.env.SOAK_TOKEN
if (!base || !token) {
  console.error('usage: SOAK_TOKEN=<access-token> node scripts/soak.mjs <base-url> [seconds]')
  process.exit(1)
}
const durationMs = (Number(secondsArg) || 3600) * 1000

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${token}`
}

const started = Date.now()
let n = 0
let failures = 0
const uptimes = []

while (Date.now() - started < durationMs) {
  await new Promise((resolve) => setTimeout(resolve, 60_000))
  n += 1

  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null)
  if (health) uptimes.push(health.uptime_s)

  // No mcp-session-id, and no initialize handshake to establish one: a stateless
  // POST carries everything the server needs.
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: n + 1, method: 'tools/list', params: {} })
  })

  const ok = r.status === 200
  if (!ok) failures += 1
  console.error(`[${Math.round((Date.now() - started) / 60000)}m] tools/list ${r.status} ${ok ? '' : '<-- FAILURE'} uptime_s=${health?.uptime_s ?? '?'}`)

  if (!ok) {
    console.error(await r.text())
    break
  }
}

// An uptime DROP means the instance restarted, or a second one answered. Either
// used to be fatal; now it is the interesting case — the run below is only
// meaningful if at least one of them happened and no poll failed.
const restarts = uptimes.filter((u, i) => i > 0 && u < uptimes[i - 1]).length
console.error(`\npolls=${n} failures=${failures} observed_restarts=${restarts}`)
console.error(failures === 0
  ? `PASS — every poll served${restarts > 0 ? `, across ${restarts} restart(s)/instance change(s)` : ' (no restart observed — redeploy mid-run to actually exercise it)'}.`
  : 'FAIL — see above.')
process.exit(failures === 0 ? 0 : 1)
