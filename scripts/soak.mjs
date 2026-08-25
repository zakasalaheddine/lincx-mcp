#!/usr/bin/env node
/**
 * Soak: poll an authenticated client for an hour and prove the property the
 * stateless transport exists to give — that RESTARTS AND EXTRA INSTANCES ARE
 * INVISIBLE to a connected client.
 *
 *   SOAK_TOKEN=<access_token> node scripts/soak.mjs https://mcp.lincx.com 3600
 *
 * This inverts the pre-stateless version of this script, which held one
 * mcp-session-id open and FAILED on an observed restart. There is no session to
 * hold any more: identity is the bearer, so the only thing that matters is that
 * every poll succeeds. Restarts are now reported as evidence, not as failure —
 * redeploy the service mid-run and the run should stay green.
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
let tokenExpired = false
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

  // A 401 at the end of a default (3600s) run is the OAuth access-token TTL
  // expiring, not a server fault — a real client refreshes silently. Counting it
  // as a failure made the one documented invocation guaranteed to report red.
  const expired = r.status === 401
  const ok = r.status === 200
  if (!ok && !expired) failures += 1
  if (expired) tokenExpired = true
  console.error(`[${Math.round((Date.now() - started) / 60000)}m] tools/list ${r.status} ${ok ? '' : '<-- FAILURE'} uptime_s=${health?.uptime_s ?? '?'}`)

  if (!ok) {
    if (expired) {
      console.error('access token expired (1h TTL) — ending the run, not a failure')
      break
    }
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
  ? `PASS — every poll served${restarts > 0 ? `, across ${restarts} restart(s)/instance change(s)` : ' (no restart observed — redeploy mid-run to actually exercise it)'}${tokenExpired ? '; run ended early on the 1h token TTL' : ''}.`
  : 'FAIL — see above.')
process.exit(failures === 0 ? 0 : 1)
