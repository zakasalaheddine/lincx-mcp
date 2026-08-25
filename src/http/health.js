import { json } from './respond.js'
import { probeStore } from '../services/sessionStore.js'
import { IS_PRODUCTION } from '../constants.js'

export function buildHealthHandler () {
  return async (_req, res) => {
    let store = 'unknown'
    let redisOk = false
    try {
      ({ store, redis_ok: redisOk } = await probeStore())
    } catch (err) {
      console.error(`[Health]  store probe failed: ${err.message}`)
    }

    json(res, 200, {
      status: judgeStatus({ store, redisOk, isProduction: IS_PRODUCTION }),
      uptime_s: Math.round(process.uptime()),
      store,
      redis_ok: redisOk
    })
  }
}

export function judgeStatus ({ store, redisOk, isProduction }) {
  if (!isProduction) return 'ok'
  return store === 'redis' && redisOk ? 'ok' : 'degraded'
}
