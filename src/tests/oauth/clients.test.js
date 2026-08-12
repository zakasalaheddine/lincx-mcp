import test from 'ava'

// test.serial throughout: these tests share a module-level store, and ava runs a
// file's tests concurrently where vitest's forked pool ran them one at a time.
import { registerClient, getClient } from '../../services/oauth/clients.js'

{ // OAuth clients
  test.serial('OAuth clients > registers and retrieves a client', async t => {
    const c = await registerClient({
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
      client_name: 'Claude'
    })
    t.regex(c.client_id, /^[a-f0-9]{32}$/)
    const fetched = await getClient(c.client_id)
    t.deepEqual(fetched?.redirect_uris, ['https://claude.ai/api/mcp/auth_callback'])
  })

  test.serial('OAuth clients > requires at least one redirect_uri', async t => {
    await t.throwsAsync(registerClient({ redirect_uris: [] }), { message: /redirect_uris/ })
  })

  test.serial('OAuth clients > rejects non-https redirect_uris (except localhost)', async t => {
    await t.throwsAsync(
      registerClient({ redirect_uris: ['http://example.com/cb'] }),
      { message: /https/ }
    )
    t.truthy(await registerClient({ redirect_uris: ['http://localhost:6274/cb'] }))
  })

  test.serial('OAuth clients > returns null for unknown client_id', async t => {
    t.is(await getClient('nope'), null)
  })
}
