/**
 * config/secrets.js — populate process.env from Secret Manager before
 * constants.js is imported.
 *
 * app.yaml is committed to git, so REDIS_URL (carries the Redis password)
 * cannot live there. In production the runtime service account reads it from
 * Secret Manager at boot. Everywhere else this is a no-op and .env still wins.
 *
 * The gate reads process.env.NODE_ENV rather than IS_PRODUCTION from
 * constants.js: this module runs BEFORE constants.js is evaluated (see
 * index.js), so importing it here would defeat the whole point.
 *
 * NEVER log a secret value — only its name and whether it resolved.
 *
 * The client is created through an injectable factory so the tests can supply a
 * fake: @google-cloud/secret-manager is CJS, and mocking it through the ESM
 * loader gave a null namespace here. A one-argument default is smaller than the
 * mock plumbing it replaces.
 */

const SECRETS = [
  { env: 'REDIS_URL', secret: 'lincx-mcp-redis-url' }
]

async function defaultCreateClient () {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
  return new SecretManagerServiceClient()
}

export async function loadSecrets ({ createClient = defaultCreateClient } = {}) {
  if (process.env.NODE_ENV !== 'production') return // .env is authoritative

  const project = process.env.GOOGLE_CLOUD_PROJECT
  if (!project) {
    console.error('[Secrets] GOOGLE_CLOUD_PROJECT unset — skipping Secret Manager')
    return
  }

  const client = await createClient()

  for (const { env, secret } of SECRETS) {
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${project}/secrets/${secret}/versions/latest`
      })
      const value = version.payload?.data?.toString()
      if (value) {
        process.env[env] = value
        console.error(`[Secrets] loaded ${env} from ${secret}`)
      } else {
        console.error(`[Secrets] ${secret} resolved empty — leaving ${env} unset`)
      }
    } catch (err) {
      // Fail open: an unset REDIS_URL falls back to the in-memory store with a
      // loud warning. That should not stop the instance from becoming healthy —
      // a boot that dies here never serves /_ah/start, and the deploy fails with
      // no useful signal.
      console.error(`[Secrets] could not read ${secret}: ${err.message}`)
    }
  }
}
