#!/usr/bin/env node
/**
 * Soak: hold an authenticated MCP session open and poll, verifying the two
 * production properties nothing else proves — that a SINGLE instance serves every
 * request, and that a session survives a realistic idle period.
 *
 *   SOAK_TOKEN=<access_token> node scripts/soak.mjs https://mcp.lincx.com 3600
 *
 * The token comes from the environment, never argv: a CLI argument lands in shell
 * history and in `ps` output. Take it from your MCP client's stored credentials
 * after a normal browser login.
 *
 * Run the 40x /health check from the plan in a second terminal while this runs —
 * two widely separated uptime_s values mean two instances are serving and
 * app.yaml is wrong.
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

const init = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'soak', version: '1.0.0' } }
  })
})
const sessionId = init.headers.get('mcp-session-id')
if (!sessionId) { console.error(`initialize failed: ${init.status}`); process.exit(1) }
// 8 chars only — a session id is not a credential, but there is no reason to
// print more of one than identifies the run.
console.error(`session ${sessionId.slice(0, 8)}… established`)

const started = Date.now()
let n = 0
let failures = 0
const uptimes = []

while (Date.now() - started < durationMs) {
  await new Promise((resolve) => setTimeout(resolve, 60_000))
  n += 1

  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null)
  if (health) uptimes.push(health.uptime_s)

  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: n + 1, method: 'tools/list', params: {} })
  })

  const ok = r.status === 200
  if (!ok) failures += 1
  console.error(`[${Math.round((Date.now() - started) / 60000)}m] tools/list ${r.status} ${ok ? '' : '<-- FAILURE'} uptime_s=${health?.uptime_s ?? '?'} active_sessions=${health?.active_sessions ?? '?'}`)

  if (!ok) {
    console.error(await r.text())
    break
  }
}

// A monotonically increasing uptime proves one instance served the whole run: a
// DROP means the instance restarted (or a second one answered), and every
// in-process MCP transport went with it.
const restarts = uptimes.filter((u, i) => i > 0 && u < uptimes[i - 1]).length
console.error(`\npolls=${n} failures=${failures} observed_restarts=${restarts}`)
console.error(restarts === 0 && failures === 0
  ? 'PASS — one instance, session held throughout.'
  : 'FAIL — see above.')
// A 401 on the last polls is the 1h OAuth access-token TTL, not a server fault —
// a real client refreshes silently. Record which it was before calling it a fail.
process.exit(restarts === 0 && failures === 0 ? 0 : 1)
