import { json } from './respond.js'
import { WORK_API_BASE_URL, WRAPPING_KEY, WRAPPING_KEY_MIN_LEN } from '../constants.js'

export function buildHealthHandler () {
  return async (_req, res) => {
    const wrappingKeyOk = Boolean(WRAPPING_KEY) &&
      WRAPPING_KEY.length >= WRAPPING_KEY_MIN_LEN

    json(res, 200, {
      status: judgeStatus({ wrappingKeyOk }),
      uptime_s: Math.round(process.uptime()),
      wrapping_key_ok: wrappingKeyOk,
      work_api: WORK_API_BASE_URL
    })
  }
}

export function judgeStatus ({ wrappingKeyOk }) {
  return wrappingKeyOk ? 'ok' : 'degraded'
}
