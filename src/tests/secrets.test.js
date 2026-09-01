import test from 'ava'
import { loadSecrets } from '../config/secrets.js'

/** A fake Secret Manager client: `read` receives the resource name. */
const fakeClient = (read) => async () => ({
  accessSecretVersion: async ({ name }) => read(name)
})

test.serial('is a no-op outside production', async t => {
  // ava sets NODE_ENV=test for the suite (package.json), so this is the default
  // state, not something the test has to arrange.
  process.env.REDIS_URL = 'redis://local'
  let called = false
  await loadSecrets({ createClient: fakeClient(() => { called = true; return [{}] }) })
  t.false(called)
  t.is(process.env.REDIS_URL, 'redis://local')
})

test.serial('populates env from Secret Manager in production', async t => {
  process.env.NODE_ENV = 'production'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  delete process.env.REDIS_URL

  await loadSecrets({
    createClient: fakeClient(() => [{ payload: { data: Buffer.from('redis://from-sm') } }])
  })
  t.is(process.env.REDIS_URL, 'redis://from-sm')
  process.env.NODE_ENV = 'test'
})

test.serial('an empty secret leaves the env var alone', async t => {
  process.env.NODE_ENV = 'production'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  process.env.REDIS_URL = 'redis://kept'
  await loadSecrets({ createClient: fakeClient(() => [{ payload: { data: Buffer.from('') } }]) })
  t.is(process.env.REDIS_URL, 'redis://kept')
  process.env.NODE_ENV = 'test'
})

test.serial('an unreadable secret does not crash the boot', async t => {
  // Fail open: dying here means /_ah/start never answers and the deploy fails
  // with no useful signal.
  process.env.NODE_ENV = 'production'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  await t.notThrowsAsync(loadSecrets({
    createClient: fakeClient(() => { throw new Error('PERMISSION_DENIED') })
  }))
  process.env.NODE_ENV = 'test'
})

test.serial('skips Secret Manager when GOOGLE_CLOUD_PROJECT is unset', async t => {
  process.env.NODE_ENV = 'production'
  delete process.env.GOOGLE_CLOUD_PROJECT
  let called = false
  await loadSecrets({ createClient: fakeClient(() => { called = true; return [{}] }) })
  t.false(called)
  process.env.NODE_ENV = 'test'
})
