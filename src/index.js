/**
 * index.js — bootstrap only.
 *
 * loadSecrets() must run BEFORE constants.js is evaluated, and constants.js is
 * imported transitively by almost everything in server.js. A static import here
 * would evaluate it too early, so server.js is imported dynamically.
 */
import { loadSecrets } from './config/secrets.js'

await loadSecrets()
const { start } = await import('./server.js')

// start() rejects rather than exiting (so a test can catch a bind failure);
// production still wants a non-zero exit so the platform restarts us.
await start().catch(() => process.exit(1))
