/**
 * dev-tunnel.mjs — `npm run dev` orchestrator.
 *
 * Quick Cloudflare tunnels mint a fresh https URL on every run, and the server
 * needs that exact URL as PUBLIC_BASE_URL (or OAuth login redirects to the wrong
 * host). So the order matters:
 *   1. start `cloudflared tunnel --url http://localhost:<PORT>`
 *   2. parse its output for the generated https://*.trycloudflare.com URL
 *   3. boot `node --watch` with PUBLIC_BASE_URL set to that URL
 *   4. print a banner so you can paste <url>/mcp into Claude Desktop
 *
 * Both children are killed on exit. To run without a tunnel, use `npm run dev:local`.
 */

import { spawn } from 'node:child_process'

const PORT = process.env.PORT ?? '5001'
const LOCAL_URL = `http://localhost:${PORT}`
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

let server = null
let publicUrl = null

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

function printBanner (url) {
  const line = '═'.repeat(64)
  process.stderr.write(
    `\n${line}\n` +
      '  Cloudflare tunnel is live\n' +
      `  Public URL:   ${url}\n` +
      `  MCP endpoint: ${url}/mcp   ← paste into Claude Desktop connector\n` +
      `  Local:        ${LOCAL_URL}\n` +
      `${line}\n\n`
  )
}

const cf = spawn('cloudflared', ['tunnel', '--url', LOCAL_URL])

cf.on('error', (err) => {
  if (err.code === 'ENOENT') {
    process.stderr.write(
      '\n[dev] cloudflared is not installed. Install it with:\n' +
        '       brew install cloudflared\n' +
        '      …or run the server without a tunnel: npm run dev:local\n\n'
    )
  } else {
    process.stderr.write(`[dev] cloudflared failed: ${err.message}\n`)
  }
  cleanup()
  process.exit(1)
})

function onTunnelOutput (buf) {
  const text = buf.toString()
  process.stderr.write(text) // pass cloudflared's own logs through
  if (!publicUrl) {
    const match = text.match(TUNNEL_URL_RE)
    if (match) {
      publicUrl = match[0]
      printBanner(publicUrl)
      startServer(publicUrl)
    }
  }
}

cf.stdout.on('data', onTunnelOutput)
cf.stderr.on('data', onTunnelOutput)

function cleanup () {
  if (cf && !cf.killed) cf.kill()
  if (server && !server.killed) server.kill()
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(0)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(0)
})
