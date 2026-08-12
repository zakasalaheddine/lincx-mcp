/**
 * http/respond.js — the Express `res.json` / `res.send` / `res.redirect`
 * replacements, over a bare Node ServerResponse.
 *
 * All logging in this project goes to stderr (console.error); these helpers do
 * not log at all.
 */

export function send (res, status, body, contentType) {
  if (res.headersSent) return
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : String(body ?? '')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export function json (res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8')
}

export function html (res, status, body) {
  send(res, status, body, 'text/html; charset=utf-8')
}

export function redirect (res, location, status = 302) {
  if (res.headersSent) return
  res.writeHead(status, { Location: location, 'Content-Length': 0 })
  res.end()
}

export function noContent (res, status) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Length': 0 })
  res.end()
}
