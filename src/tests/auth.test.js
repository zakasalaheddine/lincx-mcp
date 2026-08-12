import test from 'ava'
import { spy } from './helpers/spy.js'
import { loginWithCredentials } from '../services/auth.js'

// Stub global fetch with a canned identity-server response. globalThis.fetch is
// shared state and ava runs a file's tests concurrently, so every test here is
// test.serial and the real fetch is restored after each one.
const realFetch = globalThis.fetch

function stubFetch (status, body) {
  globalThis.fetch = spy(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  }))
}

test.afterEach(() => { globalThis.fetch = realFetch })

// loginWithCredentials — surfaces the identity server's real error
// Real observed shape from ix-id.lincx.la/auth/login: { success:false, error:"..." }
test.serial('loginWithCredentials — surfaces the identity server\'s real error > propagates body.error (not a generic mask) on 401', async t => {
  stubFetch(401, { success: false, error: 'User Not Found' })
  await t.throwsAsync(loginWithCredentials('x@y.com', 'pw'), { message: /User Not Found/ })
})

test.serial('loginWithCredentials — surfaces the identity server\'s real error > propagates body.error on a 403 (e.g. unconfirmed account)', async t => {
  stubFetch(403, { success: false, error: 'Email not confirmed' })
  await t.throwsAsync(loginWithCredentials('x@y.com', 'pw'), { message: /Email not confirmed/ })
})

test.serial('loginWithCredentials — surfaces the identity server\'s real error > returns the token on success', async t => {
  stubFetch(200, { success: true, data: { authToken: 'jwt-123' } })
  const r = await loginWithCredentials('x@y.com', 'pw')
  t.is(r.authToken, 'jwt-123')
  t.is(r.email, 'x@y.com')
})
