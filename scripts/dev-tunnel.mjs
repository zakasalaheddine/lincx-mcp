/**
 * dev-tunnel.mjs — `npm run dev` orchestrator.
 *
 * Claude Desktop and claude.ai only accept an https connector URL, so local work
 * against them needs a tunnel. Both supported tunnels mint a FRESH url per run and
 * the server must advertise that exact url as PUBLIC_BASE_URL — the OAuth
 * discovery document is built from it, so a stale value makes the client fetch
 * discovery over https and then read a `registration_endpoint` on
 * http://localhost, which it refuses ("Couldn't register with … sign-in
 * service"). Hence the order:
 *   1. start the tunnel
 *   2. learn the generated https url
 *   3. boot `node --watch` with PUBLIC_BASE_URL set to it
 *   4. print a banner with <url>/mcp to paste into the connector
 *
 * Provider selection:
 *   npm run dev              → ngrok if installed, else cloudflared
 *   npm run dev:ngrok        → force ngrok
 *   npm run dev:cloudflared  → force cloudflared
 *   TUNNEL=ngrok|cloudflared npm run dev  → same, via env
 *
 * Both children are killed on exit. For plain local work with no tunnel (Claude
 * Code via mcp-remote, curl) use `npm run dev:local`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'

const PORT = process.env.PORT ?? '5001'
const LOCAL_URL = `http://localhost:${PORT}`
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels'
const CLOUDFLARED_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

let tunnel = null
let server = null
let publicUrl = null
let shuttingDown = false

/**
 * Refuse to start if something already owns PORT.
 *
 * Without this the tunnel comes up, the spawned server dies on EADDRINUSE, and the
 * tunnel happily serves whatever stale process holds the port — which advertises
 * the OLD PUBLIC_BASE_URL. The banner then says one thing and the connector reads
 * another, which is the exact confusion this script exists to prevent.
 */
function portInUse (port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) })
    socket.setTimeout(700)
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', () => { socket.destroy(); resolve(false) })
  })
}

function installed (bin) {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0
}

function pickProvider () {
  const requested = process.argv[2]?.replace(/^--/, '') ?? process.env.TUNNEL
  if (requested === 'ngrok' || requested === 'cloudflared') return requested
  // ngrok first — it is what people here already have authenticated. Tradeoff,
  // measured: on the free plan the ngrok edge shows a browser interstitial ("You
  // are about to visit …") the first time the LOGIN PAGE is opened, so the OAuth
  // flow costs one extra click. API clients (the discovery + register + /mcp calls)
  // are not interstitialled, and `--request-header-add ngrok-skip-browser-warning`
  // does NOT suppress it — the edge decides before traffic policy runs. cloudflared
  // has no interstitial at all: use `npm run dev:cloudflared` to avoid the click.
  if (installed('ngrok')) return 'ngrok'
  if (installed('cloudflared')) return 'cloudflared'
  return null
}

function printBanner (provider, url, reused) {
  const line = '═'.repeat(70)
  process.stderr.write(
    `\n${line}\n` +
      `  ${provider} tunnel is live${reused ? ' (reused an already-running agent)' : ''}\n` +
      `  Public URL:   ${url}\n` +
      `  MCP endpoint: ${url}/mcp   ← paste into the Claude Desktop / claude.ai connector\n` +
      `  Local:        ${LOCAL_URL}\n` +
      '  PUBLIC_BASE_URL is set to the public URL, so OAuth discovery matches it.\n' +
      (provider === 'ngrok'
        ? '  ngrok free: the login page shows an interstitial once — click "Visit Site".\n'
        : '') +
      `${line}\n\n`
  )
}

function startServer (publicBaseUrl) {
  server = spawn('node', ['--watch', '--env-file=.env', 'src/index.js'], {
    stdio: 'inherit',
    env: { ...process.env, PUBLIC_BASE_URL: publicBaseUrl }
  })
  server.on('exit', (code) => {
    cleanup()
    process.exit(code ?? 0)
  })
}

function ready (provider, url, reused = false) {
  publicUrl = url
  printBanner(provider, url, reused)
  startServer(url)
}

// ── ngrok ───────────────────────────────────────────────────────────────────
//
// The agent's local API is the reliable source of the URL; its stdout format has
// changed between versions. It also lets us notice an agent that is ALREADY
// tunnelling this port — the free plan allows one simultaneous session, so
// spawning a second one just fails with ERR_NGROK_108.

async function ngrokTunnels () {
  try {
    const r = await fetch(NGROK_API)
    if (!r.ok) return []
    const { tunnels = [] } = await r.json()
    return tunnels
  } catch {
    return []
  }
}

function httpsUrlOf (t) {
  return t.public_url?.startsWith('https://') ? t.public_url : null
}

async function findNgrokUrlForPort () {
  for (const t of await ngrokTunnels()) {
    const addr = t.config?.addr ?? ''
    if (addr.endsWith(`:${PORT}`) && httpsUrlOf(t)) return httpsUrlOf(t)
  }
  return null
}

async function startNgrok () {
  const existing = await findNgrokUrlForPort()
  if (existing) return ready('ngrok', existing, true)

  tunnel = spawn('ngrok', ['http', PORT, '--log=stdout'], { stdio: ['ignore', 'pipe', 'pipe'] })
  tunnel.on('error', (err) => fail('ngrok', err))

  const onOutput = (buf) => {
    const text = buf.toString()
    if (/ERR_NGROK_108/.test(text)) {
      process.stderr.write(
        '\n[dev] ngrok refused: an agent session is already running elsewhere and the\n' +
        '      free plan allows one at a time. Stop it (or `pkill ngrok`) and retry,\n' +
        '      or use: npm run dev:cloudflared\n\n'
      )
    }
    if (/ERR_NGROK_4018|authtoken/i.test(text) && /err/i.test(text)) {
      process.stderr.write(
        '\n[dev] ngrok is not authenticated. Run:  ngrok config add-authtoken <token>\n\n'
      )
    }
    process.stderr.write(text)
  }
  tunnel.stdout.on('data', onOutput)
  tunnel.stderr.on('data', onOutput)

  // Poll the agent API rather than scraping the log — the log format has changed
  // between ngrok versions, the API has not.
  for (let i = 0; i < 40; i++) {
    if (publicUrl || shuttingDown) break
    await new Promise((resolve) => setTimeout(resolve, 250))
    const url = await findNgrokUrlForPort()
    if (url) return ready('ngrok', url)
  }
  if (!publicUrl) {
    process.stderr.write('\n[dev] ngrok did not report a public URL within 10s — giving up.\n\n')
    cleanup()
    process.exit(1)
  }
}

// ── cloudflared ─────────────────────────────────────────────────────────────

function startCloudflared () {
  tunnel = spawn('cloudflared', ['tunnel', '--url', LOCAL_URL])
  tunnel.on('error', (err) => fail('cloudflared', err))

  const onOutput = (buf) => {
    const text = buf.toString()
    process.stderr.write(text)
    if (!publicUrl) {
      const match = text.match(CLOUDFLARED_URL_RE)
      if (match) ready('cloudflared', match[0])
    }
  }
  tunnel.stdout.on('data', onOutput)
  tunnel.stderr.on('data', onOutput)
}

// ── plumbing ────────────────────────────────────────────────────────────────

function fail (provider, err) {
  if (err.code === 'ENOENT') {
    process.stderr.write(
      `\n[dev] ${provider} is not installed. Install it with:\n` +
        `       ${provider === 'ngrok' ? 'brew install ngrok' : 'brew install cloudflared'}\n` +
        '      …or run the server without a tunnel: npm run dev:local\n\n'
    )
  } else {
    process.stderr.write(`[dev] ${provider} failed: ${err.message}\n`)
  }
  cleanup()
  process.exit(1)
}

function cleanup () {
  shuttingDown = true
  if (tunnel && !tunnel.killed) tunnel.kill()
  if (server && !server.killed) server.kill()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { cleanup(); process.exit(0) })
}

if (await portInUse(PORT)) {
  process.stderr.write(
    `\n[dev] Something is already listening on :${PORT}. A tunnel would point at THAT\n` +
      '      process, which advertises its own PUBLIC_BASE_URL, and the connector would\n' +
      '      fail to register against the wrong origin. Stop it first:\n' +
      `       lsof -ti:${PORT} | xargs kill\n\n`
  )
  process.exit(1)
}

const provider = pickProvider()
if (!provider) {
  process.stderr.write(
    '\n[dev] No tunnel client found. Install one:\n' +
      '       brew install ngrok        (then: ngrok config add-authtoken <token>)\n' +
      '       brew install cloudflared\n' +
      '      …or run without a tunnel: npm run dev:local\n\n'
  )
  process.exit(1)
}

if (provider === 'ngrok') await startNgrok()
else startCloudflared()
