import test from 'ava'
import { loadSecrets } from '../config/secrets.js'

/** A fake Secret Manager client: `read` receives the resource name. */
const fakeClient = (read) => async () => ({
  accessSecretVersion: async ({ name }) => read(name)
})

test.serial('is a no-op when GAE_ENV is unset', async t => {
  delete process.env.GAE_ENV
  process.env.REDIS_URL = 'redis://local'
  let called = false
  await loadSecrets({ createClient: fakeClient(() => { called = true; return [{}] }) })
  t.false(called)
  t.is(process.env.REDIS_URL, 'redis://local')
})

test.serial('populates env from Secret Manager on GAE', async t => {
  process.env.GAE_ENV = 'standard'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  delete process.env.REDIS_URL
  delete process.env.STATS_TOKEN

  await loadSecrets({
    createClient: fakeClient((name) => {
      const value = name.includes('redis') ? 'redis://from-sm' : 'token-from-sm'
      return [{ payload: { data: Buffer.from(value) } }]
    })
  })
  t.is(process.env.REDIS_URL, 'redis://from-sm')
  t.is(process.env.STATS_TOKEN, 'token-from-sm')
  delete process.env.GAE_ENV
})

test.serial('an empty secret leaves the env var alone', async t => {
  process.env.GAE_ENV = 'standard'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  process.env.REDIS_URL = 'redis://kept'
  await loadSecrets({ createClient: fakeClient(() => [{ payload: { data: Buffer.from('') } }]) })
  t.is(process.env.REDIS_URL, 'redis://kept')
  delete process.env.GAE_ENV
})

test.serial('an unreadable secret does not crash the boot', async t => {
  // Fail open: dying here means /_ah/start never answers and the deploy fails
  // with no useful signal, which is worse than /stats 404ing.
  process.env.GAE_ENV = 'standard'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  await t.notThrowsAsync(loadSecrets({
    createClient: fakeClient(() => { throw new Error('PERMISSION_DENIED') })
  }))
  delete process.env.GAE_ENV
})

test.serial('skips Secret Manager when GOOGLE_CLOUD_PROJECT is unset', async t => {
  process.env.GAE_ENV = 'standard'
  delete process.env.GOOGLE_CLOUD_PROJECT
  let called = false
  await loadSecrets({ createClient: fakeClient(() => { called = true; return [{}] }) })
  t.false(called)
  delete process.env.GAE_ENV
})
