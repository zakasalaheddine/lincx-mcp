/**
 * index.js — bootstrap only.
 */
import { start } from './server.js'

// start() rejects rather than exiting (so a test can catch a bind failure);
// production still wants a non-zero exit so the platform restarts us.
await start().catch(() => process.exit(1))
