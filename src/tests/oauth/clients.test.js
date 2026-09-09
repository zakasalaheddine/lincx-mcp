import test from 'ava'
import { registerClient, getClient } from '../../services/oauth/clients.js'
import { verifyClient } from '../../services/tokenService.js'

test.serial('OAuth clients > registers a signed client_id', async t => {
  const c = await registerClient({
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    client_name: 'Claude'
  })
  t.truthy(c.client_id)
  t.truthy(verifyClient(c.client_id))
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
