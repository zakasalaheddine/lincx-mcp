/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/eligibility.js
 *
 * The general eligibility join: can an ad group serve in a zone, and by what
 * path? One pure predicate powers three read directions (zone→groups,
 * group→zones, serve-explain). Network-agnostic — it takes already-fetched rows
 * as arguments and never reads the active network, so a future team-vs-client /
 * multi-network access layer can feed it a different set per network without
 * touching the join.
 */

const has = (arr, v) =>
  Array.isArray(arr) && arr.includes(v)

/** ua-parser-js 1.0.37 device types, `desktop` being lincx-core's default (server/ua-parser.js). */
export const DEVICES = ['desktop', 'mobile', 'tablet', 'smarttv', 'console', 'wearable', 'embedded']
export const DEVICE_OS = ['ios', 'android', 'other']

/** getDateTimes puts every one of these on every request, valued `mon0` … `sat23`. */
export const DATE_TIME_KEYS = ['dateTimeUTC', 'dateTimeUS/Eastern', 'dateTimeUS/Central', 'dateTimeUS/Mountain', 'dateTimeUS/Pacific', 'dateTimeVisitor']
const FULL_WEEK = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].flatMap((d) => Array.from({ length: 24 }, (_, h) => d + h))

/**
 * Keys the request path always sets after the zone defaults are merged: device /
 * deviceOs from the user agent (after the query string), geoState defaulted to '',
 * and the dateTime* keys. A zone's dataAttributesDefault can never supply them.
 */
const ALWAYS_FROM_REQUEST = new Set(['device', 'deviceOs', 'geoState', ...DATE_TIME_KEYS])

/**
 * exceptParams keys findTopAds reads only AFTER selection, to keep an ad out of a
 * slot (tagDisallowedPosition / positionScopes) — never a request key, so the params
 * index never fires on them and they say nothing about whether a group serves.
 */
const POSITION_KEYS = new Set(['position', 'zoneId-position', 'templateId-position'])

/** How many values a condition, block or summary lists before it reports a total. */
export const VALUES_CAP = 20

/**
 * Keys whose every possible value lincx-core can put on a request is known: a list
 * naming all of them matches every visit. As a whitelist that is no rule; as a
 * blacklist it excludes every visit.
 */
const DOMAINS = {
  device: DEVICES,
  deviceOs: DEVICE_OS,
  ...Object.fromEntries(DATE_TIME_KEYS.map((k) => [k, FULL_WEEK]))
}
const coversDomain = (key, values) => {
  const domain = DOMAINS[key]
  if (!domain) return false
  const set = new Set(values.map(String))
  return domain.every((v) => set.has(v))
}

const nonEmpty = (xs) => Array.isArray(xs) && xs.length > 0

/**
 * The request the serving engine builds for a zone (xtendOptions), as far as config
 * can decide it: the zone-fixed keys, the zone defaults, and the segment pick. The
 * tools never assume a visit, so every key only a visit decides is a condition.
 * (Simulating a visit — for parity checks against lincx-core — lives in
 * src/tests/helpers/visitRequest.js, built from zoneResolved and pickSegments.)
 */
export function zoneRequest (zone, channel) {
  const request = { resolved: zoneResolved(zone, channel), segments: null }
  pickSegments(zone, request)
  return request
}

/**
 * The keys config decides for a zone, each as { value, source }: the zone's own
 * (source 'zone') and its defaults (source 'zone-default'), in xtendOptions' order —
 * dataAttributesDefault first, then the zone's keys, then its template. Exported for
 * the test helper that layers a visit on top.
 */
export function zoneResolved (zone, channel) {
  const resolved = {}
  for (const [k, v] of Object.entries(zone.dataAttributesDefault ?? {})) {
    if (!ALWAYS_FROM_REQUEST.has(k)) resolved[k] = { value: v, source: 'zone-default' }
  }
  const fixed = {
    channelType: channel?.type,
    publisherId: zone.publisherId,
    zoneType: zone.type,
    zoneId: zone.id,
    networkId: zone.networkId,
    creativeAssetGroupId: zone.creativeAssetGroupId
  }
  for (const [k, v] of Object.entries(fixed)) resolved[k] = { value: v, source: 'zone' }
  resolved.templateId = { value: zone.templateId, source: 'zone-default' }
  return resolved
}

/**
 * The segment pick, as findTopAds makes it, written onto the request: the candidates
 * it can pick (request.segments), or the facts that say the rows describe only some
 * visits (refusesDefaultVisits / servesOnlyPinnedVisits), or an outright refusal.
 * `pinnedSegmentId` describes a simulated visit and is only ever passed by the test
 * helper. A visit naming its own templateId needs nothing here: its value wins over
 * the picked segment's in resolveKey (templateId || segment.templateId), while the
 * pick still sets segmentId. Exported for that helper.
 */
export function pickSegments (zone, request, { pinnedSegmentId } = {}) {
  if (zone.segmentsStatus !== 'on') return request
  const segments = zone.segments ?? []
  // The segments a visit could pin — the only segmentId / segmentName values any
  // visit can ever get.
  request.pinnable = segments.map(asCandidate)
  const pinned = pinnedSegmentId !== undefined && segments.find((x) => x.id === pinnedSegmentId)
  let candidates
  if (pinned) {
    // findTopAds takes a pinned segment by id, without its lists or allocation.
    candidates = [asCandidate(pinned)]
  } else {
    // Both passes run with request.segments still null, so a list on templateId
    // reads the zone's (overridable) template, not the segment pick being built.
    candidates = segmentCandidates(zone, request)
    if (candidates.length === 0) candidates = fallbackCandidates(zone, request, segments)
    else request.unservedShare = unservedShare(zone, request)
  }
  if (!request.refused && candidates) request.segments = candidates
  return request
}

/**
 * No candidate for a visit that keeps the zone's defaults is not "no candidate for
 * any visit". A list failing only on a default passes for a visit overriding it: the
 * served visits then all override those defaults, so the rows must not be judged on
 * them — they become visit keys. Failing that, a visit pinning a segmentId still gets
 * its segment unchecked. Only a zone with no segment at all is refused outright.
 */
function fallbackCandidates (zone, request, segments) {
  const possible = segmentCandidates(zone, request, { defaultsOverridable: true })
  if (possible.length > 0) {
    request.refusesDefaultVisits = true
    request.overriddenOnServedVisits = listRejectedDefaults(zone, request)
    for (const k of request.overriddenOnServedVisits) {
      if (request.resolved[k]?.source === 'zone-default') delete request.resolved[k]
    }
    // If every served visit overrides templateId, it names its own template, and
    // that wins over any segment's (templateId || segment.templateId): the template
    // is the visit's, not a candidate's, so it is a visit key too.
    return request.overriddenOnServedVisits.includes('templateId') ? null : possible
  }
  if (segments.length > 0) {
    request.servesOnlyPinnedVisits = true
    return segments.map(asCandidate)
  }
  request.refused = true
  return null
}

/**
 * Does a segment (or the zone itself) pass its own allow/block lists for this
 * request (filterByBlackWhiteLists)? 'in', 'out', or 'unknown' when a list reads a
 * key only the visit decides. Values compare strictly, as upstream does
 * (`xs.includes(value)` / `_.isEqual`), unlike the params index, which compares
 * strings — so a numeric zone default never matches a '5' in a segment list.
 */
function listsVerdict (x, request, { defaultsOverridable = false, defaultsVary = false } = {}) {
  let unknown = false
  // With defaultsOverridable, a value the zone only defaults is not settled: a
  // visit can override it, so a list failing on it is possible, not out. With
  // defaultsVary a list passing on it is only possible too: the visit can set any
  // value, so only lists decided by keys the zone fixes are certain either way.
  const settled = (r) => !(defaultsOverridable && r.source === 'zone-default')
  const varies = (r) => defaultsVary && r.kind === 'value' && r.source === 'zone-default'
  for (const [k, xs] of Object.entries(x.allowlist || x.params || {})) {
    if (!nonEmpty(xs)) continue
    const r = resolveKey(request, k)
    if (r.kind === 'unknown' || varies(r)) unknown = true
    else if (r.kind === 'absent' || !r.value || !xs.includes(r.value)) {
      if (r.kind === 'value' && !settled(r)) unknown = true
      else return 'out'
    }
  }
  for (const [k, xs] of Object.entries(x.blocklist || x.exceptParams || {})) {
    if (!nonEmpty(xs)) continue
    const r = resolveKey(request, k)
    if (r.kind === 'unknown' || varies(r)) unknown = true
    else if (r.kind === 'value' && xs.includes(r.value)) {
      if (!settled(r)) unknown = true
      else return 'out'
    }
  }
  return unknown ? 'unknown' : 'in'
}

/**
 * The zone-default keys the zone's or a segment's lists reject (an allowlist that
 * omits the default value, or a blocklist that names it) — the keys every served
 * visit overrides when default visits are refused.
 */
function listRejectedDefaults (zone, request) {
  const keys = new Set()
  for (const x of [zone, ...(zone.segments ?? [])]) {
    for (const [k, xs] of Object.entries(x.allowlist || x.params || {})) {
      const r = request.resolved[k]
      if (nonEmpty(xs) && r?.source === 'zone-default' && !xs.includes(r.value)) keys.add(k)
    }
    for (const [k, xs] of Object.entries(x.blocklist || x.exceptParams || {})) {
      const r = request.resolved[k]
      if (nonEmpty(xs) && r?.source === 'zone-default' && xs.includes(r.value)) keys.add(k)
    }
  }
  return [...keys].sort()
}

/**
 * Every candidate a segments-on zone can serve this request with (selectNextSegment),
 * as { segmentId, templateId }: each segment that passes its lists and carries
 * allocation, plus the zone itself (segmentId null) only when it passes its own
 * lists and the segments leave allocation under 100. A segment whose lists depend
 * on the visit is a possible candidate, and only the segments certain to pass count
 * toward the allocation that can shut the zone out.
 */
function segmentCandidates (zone, request, opts) {
  const segments = (zone.segments ?? []).map((s) => ({ s, v: listsVerdict(s, request, opts) })).filter(({ v }) => v !== 'out')
  // The draw is over a total of 100 and walks the segments in order, so a segment
  // starting past a cumulative 100 is never reached. Only segments certain to pass
  // their lists count toward that 100; an uncertain one ahead keeps it reachable.
  const candidates = []
  let certainAlloc = 0
  for (const { s, v } of segments) {
    if (alloc(s) > 0 && certainAlloc < 100) candidates.push(asCandidate(s))
    if (v === 'in') certainAlloc += alloc(s)
  }
  if (listsVerdict(zone, request, opts) !== 'out' && certainAlloc < 100) {
    candidates.push({ segmentId: null, segmentName: zone.name, templateId: zone.templateId })
  }
  return candidates
}

/** A segment's share of the draw, scaled by its persona allocation (selectNextSegment). */
const alloc = (s) => (s.personaTrafficAllocation ? s.personaTrafficAllocation / 100 : 1) * (Number(s.trafficAllocation) || 0)

/**
 * The share of unpinned visits a segments zone answers with no ad at all, as
 * percent bounds { min, max, atDefaults?, zoneRules }, or undefined when no visit gets none
 * (zone-set keys taken as fixed, as everywhere here: a request sending zoneType
 * would override them).
 * selectNextSegment draws over 100: the segments that pass their lists take their
 * allocation, and the zone takes the rest only when it passes its own lists. When
 * it fails them, a draw past the passing segments' total matches nothing and
 * findTopAds throws NotFound. Lists reading a visit key or a zone default (which a
 * visit can override) make the share depend on the visit, so:
 * - max: no visit gets more — only the segments passing on every visit count.
 * - min: no visit gets less — 0 when some visit lets the zone itself pass, else
 *   every segment that can pass counts.
 * - atDefaults: the exact share for visits keeping the zone's defaults, set only
 *   when no list there reads a visit key.
 * Segments whose lists exclude each other (one mobile-only, one desktop-only, as
 * persona splits usually are) never pass together, so the real share can sit well
 * inside the bounds; telling them apart would mean judging visit-key combinations.
 */
function unservedShare (zone, request) {
  const vary = { defaultsVary: true }
  const loose = { defaultsOverridable: true }
  if (listsVerdict(zone, request, vary) === 'in') return undefined
  let always = 0
  let possible = 0
  let atDefaults = 0
  let decided = listsVerdict(zone, request) !== 'unknown'
  for (const s of zone.segments ?? []) {
    if (listsVerdict(s, request, vary) === 'in') always += alloc(s)
    if (listsVerdict(s, request, loose) !== 'out') possible += alloc(s)
    const v = listsVerdict(s, request)
    if (v === 'in') atDefaults += alloc(s)
    if (v === 'unknown') decided = false
  }
  const pct = (x) => Math.round(Math.max(0, 100 - x) * 100) / 100
  const max = pct(always)
  if (max === 0) return undefined
  const share = { min: listsVerdict(zone, request, loose) === 'out' ? pct(possible) : 0, max }
  if (decided) share.atDefaults = listsVerdict(zone, request) === 'in' ? 0 : pct(atDefaults)
  share.zoneRules = zoneListRules(zone, request)
  return share
}

/**
 * The rules in the zone's own lists that some visit fails — what an unserved visit
 * fails on: a visit key, a default the visit can override, or a zone-set value the
 * list rejects (source 'zone', failing on every visit). Same lists and comparisons
 * as listsVerdict.
 */
function zoneListRules (zone, request) {
  const rules = []
  const rule = (path, key, op, xs, r) => rules.push({
    path,
    key,
    op,
    ...capped(xs),
    source: r.kind === 'value' ? r.source : 'request',
    ...(r.kind === 'value' ? { actual: r.value } : {})
  })
  const allow = zone.allowlist ? 'allowlist' : 'params'
  for (const [k, xs] of Object.entries(zone[allow] || {})) {
    if (!nonEmpty(xs)) continue
    const r = resolveKey(request, k)
    const passes = r.kind === 'value' && r.source !== 'zone-default' && r.value && xs.includes(r.value)
    if (!passes) rule(`${allow}.${k}`, k, 'requires', xs, r)
  }
  const block = zone.blocklist ? 'blocklist' : 'exceptParams'
  for (const [k, xs] of Object.entries(zone[block] || {})) {
    if (!nonEmpty(xs)) continue
    const r = resolveKey(request, k)
    const passes = r.kind === 'absent' || (r.kind === 'value' && r.source !== 'zone-default' && !xs.includes(r.value))
    if (!passes) rule(`${block}.${k}`, k, 'excludes', xs, r)
  }
  return rules
}

/** A segment as a pick candidate: what the pick writes onto the request. */
const asCandidate = (s) => ({ segmentId: s.id, segmentName: s.name, templateId: s.templateId })

/**
 * Does the ad server refuse every visit to this zone? A segments-on zone that has
 * no segments, and whose own lists fail on every visit (overrides included), makes
 * findTopAds throw ("Zone or segments don't match allowlist/blocklist criteria")
 * before any ad group is considered. A zone with any segment is never refused
 * outright: a visit pinning a segmentId gets it unchecked.
 */
export function refusesEveryVisit (request) {
  return request?.refused === true
}

/** Does the ad server refuse the visits that keep this zone's defaults (while others serve)? */
export function refusesDefaultVisits (request) {
  return request?.refusesDefaultVisits === true
}

/**
 * The segment-pick facts a zone view carries, so every tool can say when the rows
 * describe only some visits: the default visit is refused (and which defaults the
 * served visits override), only visits pinning a segmentId are served, or a share of
 * unpinned visits gets no ad (unservedShare).
 */
export function segmentPickFlags (request) {
  if (request?.refusesDefaultVisits) return { refusesDefaultVisits: true, overriddenOnServedVisits: request.overriddenOnServedVisits }
  if (request?.servesOnlyPinnedVisits) return { servesOnlyPinnedVisits: true }
  if (request?.unservedShare) return { unservedShare: request.unservedShare }
  return {}
}

/**
 * The keys the segment pick sets, each read off a candidate: findTopAds writes the
 * picked segment's template, id and name onto the request (the zone itself, when it
 * is the pick, gives its own id and name) before the params index runs.
 */
const SEGMENT_KEYS = {
  templateId: (c) => c.templateId,
  segmentId: (c, request) => c.segmentId ?? request.resolved.zoneId?.value,
  segmentName: (c) => c.segmentName
}

/**
 * How a request answers one key: a value, a set of segment candidates, absent, or
 * unknown. A visit's own values win; a key the segment pick sets is read per
 * candidate; anything else unresolved is unknown — or absent, when the test helper
 * marks the simulated visit complete (`unresolved: 'absent'`), except the dateTime*
 * keys, whose value is the visit's clock.
 */
function resolveKey (request, key) {
  const r = request.resolved[key]
  if (r?.source === 'request') return { kind: 'value', ...r }
  if (SEGMENT_KEYS[key] && request.segments) return { kind: 'segment', segments: request.segments }
  if (r) return { kind: 'value', ...r }
  return request.unresolved === 'absent' && !DATE_TIME_KEYS.includes(key) ? { kind: 'absent' } : { kind: 'unknown' }
}

const capped = (values) => ({ values: values.slice(0, VALUES_CAP), valuesTotal: values.length })

/**
 * Judge one rule (a params / exceptParams list, or a legacy field) against the
 * request, recording a block, a condition or a match on `out`.
 */
function judgeRule (out, request, { path, key, op, values: rawValues, test }) {
  const values = rawValues.map(String)
  const r = resolveKey(request, key)
  if (r.kind === 'unknown') {
    out.conditions.push({ path, key, op, ...capped(values), source: 'request' })
    return
  }
  if (r.kind === 'absent') {
    if (op === 'requires') out.blocks.push({ path, key, op, ...capped(values), source: 'request', actual: null, overridable: false })
    return
  }
  if (r.kind === 'segment') {
    // Which segment the ad server picks decides this rule, so each candidate says
    // whether the row passes when that one is picked.
    const read = SEGMENT_KEYS[key]
    const candidates = r.segments.map((c) => {
      const hit = test(values, read(c, request))
      return { ...c, passes: op === 'requires' ? hit : !hit }
    })
    const picked = [...new Set(r.segments.map((c) => read(c, request)))]
    if (candidates.every((c) => !c.passes)) out.blocks.push({ path, key, op, ...capped(values), source: 'segment', actual: picked, overridable: visitCanSatisfy(request, key, op, values) })
    else if (candidates.some((c) => !c.passes)) out.conditions.push({ path, key, op, ...capped(values), source: 'segment', candidates })
    else if (op === 'requires') out.matchedKeys.push({ path, key, value: picked, source: 'segment' })
    return
  }
  const hit = test(values, r.value)
  if (op === 'requires' && hit) out.matchedKeys.push({ path, key, value: r.value, source: r.source })
  if (op === 'requires' ? !hit : hit) {
    out.blocks.push({ path, key, op, ...capped(values), source: r.source, actual: r.value ?? null, overridable: r.source === 'zone-default' })
  }
}

const exact = (values, actual) => values.includes(String(actual))

/**
 * Could some visit satisfy a rule on a key the segment pick sets, though no
 * candidate does? A visit can name any templateId (it wins over the pick), but its
 * segmentId and segmentName can only come from a segment the zone has, by pinning
 * it — pinning an unknown id falls back to the pick.
 */
function visitCanSatisfy (request, key, op, values) {
  if (key === 'templateId') return true
  return passesPinnable(request, [{ key, op, values }])
}

/** Does some segment the zone has (one a visit could pin) pass every one of these rules? */
function passesPinnable (request, rules) {
  return (request?.pinnable ?? []).some((s) => rules.every(({ key, op, values }) => {
    const hit = values.includes(String(SEGMENT_KEYS[key](s, request)))
    return op === 'requires' ? hit : !hit
  }))
}

/**
 * One entity's verdict on every params / exceptParams key except zoneId (the
 * zone-scoping logic owns that one), plus an ad group's legacy geo / devices fields,
 * with lincx-core's semantics (getQueryCommands, adGroupModel.selectBy):
 * - an empty list is no rule;
 * - a params list needs the key on the request with a listed value — absent excludes;
 * - an exceptParams list excludes on a listed value and never fires on an absent key;
 * - values compare as strings; the legacy geo field compares the request uppercased;
 * - a list naming every value a key can take (all 168 dateTime* day-hours, all seven
 *   devices, all three deviceOs values) matches every request: no rule as a
 *   whitelist, and a block with source 'always' as a blacklist;
 * - the position keys are slot rules applied after selection, so they are skipped.
 * A key config cannot decide becomes a condition rather than a verdict.
 */
export function paramsVerdict (entity, request, { legacy = false } = {}) {
  const out = { blocks: [], conditions: [], matchedKeys: [] }
  if (request) {
    for (const [key, values] of Object.entries(entity.params ?? {})) {
      if (key === 'zoneId' || !nonEmpty(values) || coversDomain(key, values)) continue
      judgeRule(out, request, { path: `params.${key}`, key, op: 'requires', values, test: exact })
    }
    for (const [key, values] of Object.entries(entity.exceptParams ?? {})) {
      if (key === 'zoneId' || POSITION_KEYS.has(key) || !nonEmpty(values)) continue
      if (coversDomain(key, values)) {
        out.blocks.push({ path: `exceptParams.${key}`, key, op: 'excludes', ...capped(values.map(String)), source: 'always', actual: null, overridable: false })
        continue
      }
      judgeRule(out, request, { path: `exceptParams.${key}`, key, op: 'excludes', values, test: exact })
    }
    if (legacy && nonEmpty(entity.geo)) {
      judgeRule(out, request, { path: 'geo', key: 'geoState', op: 'requires', values: entity.geo, test: (values, actual) => values.includes(String(actual).toUpperCase()) })
    }
    if (legacy && nonEmpty(entity.devices) && !coversDomain('device', entity.devices)) {
      judgeRule(out, request, { path: 'devices', key: 'device', op: 'requires', values: entity.devices, test: exact })
    }
  }
  return { allowed: out.blocks.length === 0, ...out, conditional: out.conditions.length > 0 }
}

/**
 * The first key on which a set of conditions can never all hold on one visit, as
 * { key, overridable }, or null — overridable when only the segment pick stands in
 * the way and a visit naming its own templateId would satisfy them. For a visit key,
 * the values every `requires` list allows, net of every `excludes` list, must leave
 * at least one; with only `excludes`, they must not name every value the key can
 * take. For the keys the segment pick sets, one candidate must pass them all, since a
 * visit gets exactly one. A key carrying a legacy `geo` rule, and capped lists, are
 * not judged (they stay conditional rather than risk a false "never").
 */
export function contradiction (conditions, request) {
  const byKey = new Map()
  for (const c of conditions) {
    if (c.source === 'segment') continue
    if (!byKey.has(c.key)) byKey.set(c.key, [])
    byKey.get(c.key).push(c)
  }
  for (const [key, cs] of byKey) {
    // Two conditions at most can meet on a key with a legacy geo rule (ads carry no
    // geo, and lincx-core refuses geo with params.geoState), and selectBy compares
    // stored geo as saved — nothing here can judge that pair safely.
    if (cs.length < 2 || cs.some((c) => c.path === 'geo')) continue
    const excluded = new Set(cs.filter((c) => c.op === 'excludes').flatMap((c) => c.values))
    const requires = cs.filter((c) => c.op === 'requires')
    if (requires.length > 0) {
      if (requires.some((c) => c.valuesTotal > c.values.length)) continue
      let allowed = requires[0].values
      for (const c of requires.slice(1)) allowed = allowed.filter((v) => c.values.includes(v))
      if (allowed.every((v) => excluded.has(v))) return { key, overridable: false }
    } else if (DOMAINS[key]?.every((v) => excluded.has(v))) {
      return { key, overridable: false }
    }
  }
  // Checked after the visit keys: an overridable segment clash must not hide a
  // "never" on another key.
  return segmentClash(conditions.filter((c) => c.source === 'segment'), request)
}

/**
 * Segment-set rules that no single candidate passes all of. A visit can still clear
 * them by naming its own templateId (it beats the pick) and by pinning one of the
 * zone's segments (the only segmentId / segmentName values a visit can get) — so the
 * clash is overridable when some template value satisfies every template rule AND
 * some existing segment satisfies every segmentId / segmentName rule, and "never"
 * otherwise. Capped lists are not judged (left overridable).
 */
function segmentClash (segment, request) {
  if (segment.length < 2 || segment[0].candidates.some((_, i) => segment.every((c) => c.candidates[i]?.passes))) return null
  const key = segment.find((c) => c.key !== 'templateId')?.key ?? 'templateId'
  const templates = segment.filter((c) => c.key === 'templateId')
  const requires = templates.filter((c) => c.op === 'requires')
  const excluded = new Set(templates.filter((c) => c.op === 'excludes').flatMap((c) => c.values))
  const judged = requires.length > 0 && requires.every((c) => c.valuesTotal === c.values.length)
  const allowed = judged ? requires.slice(1).reduce((acc, c) => acc.filter((v) => c.values.includes(v)), requires[0].values) : null
  const templateNever = judged && allowed.every((v) => excluded.has(v))
  const pinRules = segment.filter((c) => c.key !== 'templateId')
  const pinJudged = pinRules.length > 0 && pinRules.every((c) => c.valuesTotal === c.values.length)
  const segmentNever = pinJudged && !passesPinnable(request, pinRules)
  return { key, overridable: !templateNever && !segmentNever }
}

const blockReasons = (blocks, prefix = '') =>
  [...new Set(blocks.map((b) => `${prefix}${b.op === 'requires' ? 'param-mismatch' : 'param-blacklisted'}`))]

/**
 * The single `scoped_via` domain — HOW a group/offer is scoped to a zone. Shared
 * by every tool that emits the field (the group-grain rollup in
 * zoneInventoryTools and the offer grain in `offerEligibility`) so a consumer
 * reading them together never sees the same field name over two different
 * enums. NOT the same field as `Eligibility.via`, which is the narrower
 * "why is this group eligible" path (whitelist / CAG) and stays as-is.
 */
export const SCOPED_VIA = [
  'ad-group-whitelist',
  'ad-group-blacklist',
  'ad-level-whitelist',
  'ad-level-blacklist',
  'zone-selection'
]

/**
 * Can the group reach the zone at all, before any rule beyond zoneId? Not archived,
 * CAG match (a zone with no CAG — falsy, so null too — drops that filter entirely, as
 * filterByCreativeAssetGroupId does), not blacklisted (exceptParams.zoneId always
 * wins), and in scope: it whitelists the zone or targets ZERO zones (open within its
 * CAG → "free radical").
 */
function zoneScope (adGroup, zone) {
  const cagScoped = Boolean(zone.creativeAssetGroupId)
  const cagMatch = cagScoped && adGroup.creativeAssetGroupId === zone.creativeAssetGroupId
  const cagOk = !cagScoped || cagMatch
  const inParams = has(adGroup.params?.zoneId, zone.id)
  const inExcept = has(adGroup.exceptParams?.zoneId, zone.id)
  const targetsZeroZones = (adGroup.params?.zoneId?.length ?? 0) === 0

  const via = []
  if (inParams) via.push('ad-group-whitelist')
  if (cagMatch) via.push('zone-selection')
  const conflicts = []
  if (inParams && inExcept) conflicts.push('targets-and-excepts')
  if (inParams && !cagOk) conflicts.push('whitelisted-cag-mismatch')

  let reason = null
  if (adGroup.archived === true) reason = 'archived'
  else if (inExcept) reason = 'blacklisted'
  else if (!cagOk) reason = 'cag-mismatch'
  else if (!inParams && !targetsZeroZones) reason = 'targets-other-zones'
  return { zoneOk: reason === null, reasons: reason ? [reason] : [], via, conflicts, blacklisted: inExcept }
}

/**
 * GROUP-level eligibility: can this ad group serve ANY ad in this zone? Zone scoping
 * first (zoneScope); then, with a `request` (zoneRequest), every other params /
 * exceptParams key and the legacy geo / devices fields (paramsVerdict):
 * - `eligible` — serves on every request this answer describes;
 * - `conditional` — depends on a key only the visit decides (`conditions[]`);
 * - `excluded` — blocked on scoping or on a decided key (`paramBlocks[]`), or on
 *   conditions that never hold together. A block wins over a condition.
 *   `excludedByDefault` marks a zone-scoped group blocked only by a zone default a
 *   visit could override — never one that also clashes for good.
 * `eligible` stays a boolean, true only for verdict 'eligible'. Ad-level params are
 * NOT a group-scoping mechanism — they only filter WHICH ads serve within the group
 * (see adVerdict).
 */
export function eligibility ({ adGroup, zone, request }) {
  const scope = zoneScope(adGroup, zone)
  // Rules beyond zoneId only matter once the group can reach the zone at all. Run on
  // an out-of-scope group, their blocks read as a cause the request could fix.
  const pv = paramsVerdict(adGroup, scope.zoneOk ? request : undefined, { legacy: true })
  const reasons = [...scope.reasons, ...blockReasons(pv.blocks)]
  const clash = scope.zoneOk ? contradiction(pv.conditions, request) : null
  if (clash) reasons.push('conditions-contradict')
  const verdict = !scope.zoneOk || pv.blocks.length > 0 || clash ? 'excluded' : pv.conditional ? 'conditional' : 'eligible'
  const overridableBlocks = pv.blocks.length > 0 && pv.blocks.every((b) => b.overridable)
  // Default-blocked only when nothing stands in the way that no visit can lift: every
  // block overridable, and any clash overridable too.
  const excludedByDefault = scope.zoneOk &&
    (pv.blocks.length === 0 || overridableBlocks) &&
    (!clash || clash.overridable) &&
    (overridableBlocks || clash?.overridable === true)

  return {
    adGroupId: adGroup.id,
    zoneId: zone.id,
    eligible: verdict === 'eligible',
    verdict,
    conditional: verdict === 'conditional',
    via: scope.via,
    blacklisted: scope.blacklisted,
    excludedByDefault,
    reasons,
    conflicts: scope.conflicts,
    conditions: pv.conditions,
    paramBlocks: pv.blocks,
    matchedKeys: pv.matchedKeys,
    ...clashFields(clash)
  }
}

/** The contradiction as row fields: the key, and a flag when a visit could still clear it. */
function clashFields (clash) {
  if (!clash) return {}
  return { contradiction: clash.key, ...(clash.overridable ? { contradictionOverridable: true } : {}) }
}

/**
 * Per-ad LAST targeting check, applied only within a group already in scope for the
 * zone: the ad's own `exceptParams.zoneId` blacklists it there, its own non-empty
 * `params.zoneId` whitelist omitting the zone confines it elsewhere, and — with a
 * request — its other params / exceptParams keys run through paramsVerdict (ads have
 * no legacy geo / devices fields). One excluded ad is hidden while its siblings serve.
 */
export function adVerdict (ad, zoneId, request) {
  if (has(ad.exceptParams?.zoneId, zoneId)) return { verdict: 'excluded', reasons: ['ad-blacklisted'], conditions: [], paramBlocks: [], matchedKeys: [] }
  const wl = ad.params?.zoneId
  if (Array.isArray(wl) && wl.length > 0 && !wl.includes(zoneId)) {
    return { verdict: 'excluded', reasons: ['ad-targets-other-zones'], conditions: [], paramBlocks: [], matchedKeys: [] }
  }
  const pv = paramsVerdict(ad, request)
  const clash = contradiction(pv.conditions, request)
  const verdict = pv.blocks.length > 0 || clash ? 'excluded' : pv.conditional ? 'conditional' : 'eligible'
  const reasons = [...blockReasons(pv.blocks, 'ad-'), ...(clash ? ['ad-conditions-contradict'] : [])]
  return { verdict, reasons, conditions: pv.conditions, paramBlocks: pv.blocks, matchedKeys: pv.matchedKeys, clash }
}

/** Can this ad serve here at all? A conditional ad can, on matching traffic. */
export function adServesInZone (ad, zoneId, request) {
  return adVerdict(ad, zoneId, request).verdict !== 'excluded'
}

/** How an (ad group × ad) pair is scoped to the zone, in the shared SCOPED_VIA enum. */
function scopedVia (adGroup, ad, zone) {
  const scoped_via = []
  if (has(adGroup.params?.zoneId, zone.id)) scoped_via.push('ad-group-whitelist')
  if (has(adGroup.exceptParams?.zoneId, zone.id)) scoped_via.push('ad-group-blacklist')
  if (has(ad.params?.zoneId, zone.id)) scoped_via.push('ad-level-whitelist')
  if (has(ad.exceptParams?.zoneId, zone.id)) scoped_via.push('ad-level-blacklist')
  // Only a REAL shared CAG is a scoping path. A zone with no CAG lets every group
  // through the filter, which is the absence of scoping, not zone-selection.
  if (zone.creativeAssetGroupId && adGroup.creativeAssetGroupId === zone.creativeAssetGroupId) {
    scoped_via.push('zone-selection')
  }
  return scoped_via
}

/**
 * The pair's verdict from the group's and the ad's: excluded if either is; else
 * conditional if either is — unless their conditions can never hold together (group:
 * mobile only; ad: never mobile), so the pair is judged as one rule set.
 */
function combineVerdicts (group, av, request) {
  const groupVerdict = group.verdict ?? (group.eligible ? 'eligible' : 'excluded')
  const reasons = [...group.reasons]
  if (groupVerdict === 'excluded') return { verdict: 'excluded', groupVerdict, reasons, clash: null }
  if (av.verdict === 'excluded') return { verdict: 'excluded', groupVerdict, reasons: [...reasons, ...av.reasons], clash: av.clash ?? null }
  if (av.verdict !== 'conditional' && groupVerdict !== 'conditional') return { verdict: groupVerdict, groupVerdict, reasons, clash: null }
  const clash = contradiction([...(group.conditions ?? []), ...av.conditions], request)
  return clash
    ? { verdict: 'excluded', groupVerdict, reasons: [...reasons, 'conditions-contradict'], clash }
    : { verdict: 'conditional', groupVerdict, reasons, clash: null }
}

/**
 * OFFER grain: a single (ad group × ad) pair evaluated against a zone, on top of an
 * already-computed group verdict. The group verdict decides whether the pair can be
 * considered at all (filterAdgroups runs first — an ad-level whitelist can never
 * rescue an ineligible group); the ad's own params/exceptParams are then the last
 * check. The pair is conditional when either side is and neither is excluded.
 *
 * A **free radical** at this grain is an untargeted ad under an untargeted group, net
 * of blacklists at BOTH levels — i.e. it reaches the zone solely via the shared CAG.
 * An ad whose own `params.zoneId` names the zone is ad-level-TARGETED, not a free
 * radical (counting it as one over-counts the CAG leak). `freeRadical` is that
 * zone-only test on any pair not excluded; `verdict` says whether it is certain.
 */
export function offerEligibility ({ group, adGroup, ad, zone, request }) {
  const scoped_via = scopedVia(adGroup, ad, zone)
  const av = adVerdict(ad, zone.id, request)
  const { verdict, groupVerdict, reasons, clash } = combineVerdicts(group, av, request)

  const freeRadical = verdict !== 'excluded' &&
    !scoped_via.includes('ad-group-whitelist') &&
    !scoped_via.includes('ad-level-whitelist')

  // An ad-level whitelist naming a zone its GROUP cannot reach never fires —
  // filterAdgroups() drops the group before filterAds() is consulted. The config
  // reads as "this ad is targeted here" and does nothing. Field-found on Adnet:
  // 18 ads across 8 groups, 6 of them live, where a Facebook-zone carve-out was
  // rolled out on the ads but the parent group was never scoped to that zone.
  const conflicts = []
  if (scoped_via.includes('ad-level-whitelist') && groupVerdict === 'excluded' && !group.excludedByDefault) {
    conflicts.push('inert-ad-level-whitelist')
  }

  return {
    adGroupId: adGroup.id,
    adId: ad.id ?? '',
    zoneId: zone.id,
    serves: verdict === 'eligible',
    verdict,
    conditional: verdict === 'conditional',
    scoped_via,
    freeRadical,
    reasons,
    conflicts,
    conditions: av.conditions,
    paramBlocks: av.paramBlocks,
    matchedKeys: av.matchedKeys,
    ...clashFields(clash)
  }
}

const CONDITIONAL_ADS_CAP = 10

/**
 * Per-group offer-grain counts, so a pure free-radical subset is derivable. The
 * existing counts are CERTAIN offers only (verdict 'eligible'); conditional offers
 * have their own twins and sit in neither the certain nor the excluded counts, and
 * `conditionalAds` names the ads whose own rules depend on the visit.
 *
 * `isLive(ad)` is injected rather than derived here: liveness needs the campaign
 * and creative rows, which this module deliberately never reads (it stays pure and
 * network-agnostic). Callers pass `campaign_on && adgroup_on && adLiveViable(ad,
 * creatives)`. Required, not defaulted — a default would make a wrong count look
 * like a passing assertion.
 */
export function offerRollup ({ group, adGroup, ads, zone, isLive, request }) {
  const offers = ads.map((ad) => ({ ...offerEligibility({ group, adGroup, ad, zone, request }), live: isLive(ad) }))
  const certain = offers.filter((o) => o.serves)
  const conditional = offers.filter((o) => o.conditional)
  const freeRadicals = certain.filter((o) => o.freeRadical)
  const freeRadicalsConditional = conditional.filter((o) => o.freeRadical)
  const inert = offers.filter((o) => o.conflicts.includes('inert-ad-level-whitelist'))
  return {
    total: offers.length,
    inScope: certain.length,
    live: certain.filter((o) => o.live).length,
    conditional: conditional.length,
    conditionalLive: conditional.filter((o) => o.live).length,
    freeRadical: freeRadicals.length,
    freeRadicalLive: freeRadicals.filter((o) => o.live).length,
    freeRadicalConditional: freeRadicalsConditional.length,
    freeRadicalConditionalLive: freeRadicalsConditional.filter((o) => o.live).length,
    adLevelTargeted: offers.filter((o) => o.scoped_via.includes('ad-level-whitelist')).length,
    adLevelBlacklisted: offers.filter((o) => o.scoped_via.includes('ad-level-blacklist')).length,
    confinedElsewhere: offers.filter((o) => o.reasons.includes('ad-targets-other-zones')).length,
    inertWhitelisted: inert.length,
    freeRadicalAdIds: freeRadicals.map((o) => o.adId).filter(Boolean),
    inertWhitelistedAdIds: inert.map((o) => o.adId).filter(Boolean),
    // The ads whose OWN rules make them depend on the visit (capped; `conditional`
    // is the full count). Group-level conditions are on the row itself.
    conditionalAds: conditional
      .filter((o) => o.conditions.length > 0)
      .slice(0, CONDITIONAL_ADS_CAP)
      .map((o) => ({ adId: o.adId, conditions: o.conditions }))
  }
}

/**
 * zone → its ad groups bucketed by how they are scoped (NOT by eligibility — each
 * row's `verdict` says whether it serves):
 * - `directlyTargeted` — ad-group-whitelisted and not blacklisted (= the inventory
 *   tool's targeted set; reconciles to it). Kept whatever the verdict (CAG mismatch,
 *   a params block, a visitor condition) so config problems surface via each row's
 *   `conflicts`/`reasons`/`paramBlocks` instead of silently vanishing.
 * - `freeRadicals` — not ad-group-whitelisted, in scope via the shared CAG, and
 *   eligible OR conditional. HOST grain: the free radical is the OFFER, the group
 *   only hosts it, so a row here can hold zero free-radical OFFERS (e.g. its only ad
 *   is zone-whitelisted → that ad renders because it is ad-level-targeted, not via
 *   the CAG). Use `offerRollup` for the offer-grain count, incl. `freeRadicalLive`
 *   (a dormant host leaks nothing).
 * - `conflicting` — ad-group-whitelisted AND blacklisted (targets+excepts the zone).
 * - `inertWhitelists` — excluded for the zone, yet one of its ads whitelists the
 *   zone. Nothing here serves; it is a pure config-defect bucket. Without it these
 *   groups are dropped, and a dead ad-level whitelist is undiscoverable — the config
 *   reads as "targeted here" in the UI and does nothing.
 * - `excludedByDefault` — in scope for the zone but blocked only by a zone default
 *   (dataAttributesDefault, templateId, a segment template) a visit can override.
 * Everything else is dropped.
 *
 * The reconciliation invariant is untouched: `inertWhitelists` and
 * `excludedByDefault` groups are, by construction, not ad-group-whitelisted, so they
 * cannot appear in `directlyTargeted` or `conflicting`.
 */
export function zoneEligibility (adGroups, zone, adsByGroup, request) {
  const directlyTargeted = []
  const freeRadicals = []
  const conflicting = []
  const inertWhitelists = []
  const excludedByDefault = []
  for (const adGroup of adGroups) {
    const ads = adsByGroup[adGroup.id] ?? []
    const e = eligibility({ adGroup, zone, request })
    const agWhitelist = e.via.includes('ad-group-whitelist')
    if (agWhitelist && e.blacklisted) conflicting.push(e)
    else if (agWhitelist) directlyTargeted.push(e)
    else if (e.verdict !== 'excluded') freeRadicals.push(e)
    else if (e.excludedByDefault) excludedByDefault.push(e)
    else if (ads.some((ad) => has(ad.params?.zoneId, zone.id))) {
      inertWhitelists.push({ ...e, conflicts: [...e.conflicts, 'inert-ad-level-whitelist'] })
    }
  }
  return { directlyTargeted, freeRadicals, conflicting, inertWhitelists, excludedByDefault }
}

/**
 * group → every zone it can serve or leak into (the flip of zoneEligibility): the
 * zones where its verdict is eligible or conditional, plus the zones where only an
 * overridable zone default blocks it (`excludedByDefault`), which the caller splits
 * out. `requestFor(zone)` supplies each zone's request.
 */
export function adGroupReach (adGroup, zones, requestFor = () => undefined) {
  return zones
    .map((zone) => eligibility({ adGroup, zone, request: requestFor(zone) }))
    .filter((e) => e.verdict !== 'excluded' || e.excludedByDefault)
}
