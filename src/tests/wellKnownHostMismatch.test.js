import test from 'ava'
import request from 'supertest'
import { buildContractApp } from './contract/buildApp.js'
import { PUBLIC_BASE_URL } from '../constants.js'

// The failure this guards is silent on the server and unreadable on the client:
// discovery served over a tunnel while PUBLIC_BASE_URL still says http://localhost
// makes Claude Desktop report only "Couldn't register with the sign-in service".
const realConsoleError = console.error

function captureStderr (fn) {
  const lines = []
  console.error = (...args) => lines.push(args.join(' '))
  return Promise.resolve(fn()).finally(() => { console.error = realConsoleError }).then(() => lines)
}

test.serial('warns when discovery is served for a host PUBLIC_BASE_URL does not match', async t => {
  const app = buildContractApp()
  const lines = await captureStderr(async () => {
    const r = await request(app)
      .get('/.well-known/oauth-authorization-server')
      .set('x-forwarded-host', 'abc123.ngrok-free.app')
    t.is(r.status, 200)
    // The document is still served, and still self-consistent — the warning is the
    // only signal, because serving a different issuer per Host header would be a
    // host-header trust hole.
    t.is(r.body.issuer, PUBLIC_BASE_URL)
  })
  t.true(
    lines.some((l) => l.includes('abc123.ngrok-free.app') && l.includes('PUBLIC_BASE_URL')),
    `expected a mismatch warning, got: ${JSON.stringify(lines)}`
  )
})

test.serial('warns only once per host', async t => {
  const app = buildContractApp()
  const lines = await captureStderr(async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).get('/.well-known/oauth-protected-resource').set('x-forwarded-host', 'repeat.example.com')
    }
  })
  t.is(lines.filter((l) => l.includes('repeat.example.com')).length, 1)
})

test.serial('stays quiet when the host matches PUBLIC_BASE_URL', async t => {
  const app = buildContractApp()
  const expected = new URL(PUBLIC_BASE_URL).host
  const lines = await captureStderr(async () => {
    const r = await request(app)
      .get('/.well-known/oauth-authorization-server')
      .set('x-forwarded-host', expected)
    t.is(r.status, 200)
  })
  t.deepEqual(lines, [])
})
