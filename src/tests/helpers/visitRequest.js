/**
 * tests/helpers/visitRequest.js
 *
 * Test-only: the request a SPECIFIC visit produces, for checking the eligibility join
 * against what lincx-core serves. The tools never simulate a visit — they call
 * zoneRequest(zone, channel) and leave every visit key as a condition.
 *
 *   visitRequest(zone, channel, { device: 'mobile', s1: 'xyz' })        // a partial visit
 *   visitRequest(zone, channel, { geoState: 'TX' }, { complete: true })  // the whole visit
 *
 * `complete` makes the given keys the whole visit: a key it does not name is absent
 * (a whitelist on it excludes, a blacklist never fires) — except the keys every real
 * visit carries (device desktop, deviceOs other, geoState '') and the dateTime* keys,
 * which stay conditions unless given, since their value is the visit's clock. A
 * `segmentId` naming one of the zone's segments pins it, and a `templateId` wins over
 * the picked segment's template, as findTopAds does.
 */
import { zoneResolved, pickSegments } from '../../tools/eligibility.js'

const VISIT_DEFAULTS = { device: 'desktop', deviceOs: 'other', geoState: '' }

export function visitRequest (zone, channel, visit = {}, { complete = false } = {}) {
  const resolved = zoneResolved(zone, channel)
  const given = complete ? { ...VISIT_DEFAULTS, ...visit } : visit
  for (const [k, v] of Object.entries(given)) {
    // On a segments zone findTopAds overwrites segmentId / segmentName with the pick's.
    if ((k === 'segmentId' || k === 'segmentName') && zone.segmentsStatus === 'on') continue
    resolved[k] = { value: v, source: 'request' }
  }
  const request = { resolved, segments: null, ...(complete ? { unresolved: 'absent' } : {}) }
  return pickSegments(zone, request, { pinnedSegmentId: visit.segmentId })
}
