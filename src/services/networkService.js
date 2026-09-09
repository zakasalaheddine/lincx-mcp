/**
 * services/networkService.js
 *
 * Fetches the list of networks the authenticated user belongs to.
 * Uses the same Work API — no separate Network Service exists.
 *
 * Throws on timeout/upstream failure — an empty array means a genuinely
 * empty account, and callers must surface failures as errors rather than
 * "no networks". Adjust NETWORKS_PATH if your endpoint differs.
 */

import { WORK_API_BASE_URL } from '../constants.js'

const NETWORKS_PATH = '/api/networks'

export async function fetchUserNetworks (authToken) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(`${WORK_API_BASE_URL}${NETWORKS_PATH}`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: controller.signal
    })

    if (!res.ok) {
      throw new Error(`GET ${NETWORKS_PATH} failed: HTTP ${res.status}`)
    }

    const body = await res.json()

    // Handle common response shapes: { networks: [] } | { data: [] } | { items: [] } | []
    const raw = (
      Array.isArray(body?.networks)
        ? body.networks
        : Array.isArray(body?.data)
          ? body.data
          : Array.isArray(body?.items)
            ? body.items
            : Array.isArray(body) ? body : []
    )

    return raw.map((n) => ({
      id: String(n.id),
      name: String(n.name ?? n.id),
      owner: String(n.owner ?? ''),
      members: Array.isArray(n.members) ? n.members : [],
      observers: Array.isArray(n.observers) ? n.observers : [],
      dateCreated: String(n.dateCreated ?? ''),
      dateUpdated: String(n.dateUpdated ?? ''),
      userUpdated: String(n.userUpdated ?? ''),
      customDimensions: Array.isArray(n.customDimensions)
        ? (n.customDimensions)
        : [],
      // Upstream deletes `archived` on unarchive, so absent = active.
      archived: n.archived === true
    }))
  } catch (err) {
    const e = err instanceof Error && err.name === 'AbortError'
      ? new Error(`GET ${NETWORKS_PATH} timed out after 10s`)
      : err
    console.error('[Networks] fetch failed:', e instanceof Error ? e.message : String(e))
    throw e
  } finally {
    clearTimeout(timer)
  }
}
