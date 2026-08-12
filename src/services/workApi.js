/**
 * services/workApi.js
 *
 * Authenticated HTTP client for the Work API.
 *
 * Multi-tenancy is handled via ?networkId=<id> on every request.
 * networkId is ALWAYS injected from session.active_network server-side —
 * Claude (the AI client) never passes it directly.
 *
 * Security contract:
 *   - Authorization header  → from session.auth_token   (never from client)
 *   - networkId query param → from session.active_network (never from client)
 */

import { WORK_API_BASE_URL, CHARACTER_LIMIT } from '../constants.js'

export async function workApiRequest (
  session,
  method,
  path,
  options = {}
) {
  const params = new URLSearchParams()
  // networkId always injected here — client tools never pass it
  params.set('networkId', session.active_network)
  for (const [k, v] of Object.entries(options.params ?? {})) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      // Repeat the key per element (?d=zone&d=template) — OpenAPI form/explode,
      // which is what the Work API expects for array params like `d`.
      for (const item of v) {
        if (item !== undefined && item !== null) params.append(k, String(item))
      }
    } else {
      params.set(k, String(v))
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)

  let res
  try {
    res = await fetch(`${WORK_API_BASE_URL}${path}?${params}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.auth_token}`,
        'Content-Type': 'application/json'
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' })
    }
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { code: 'ECONNREFUSED' })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    const httpError = Object.assign(new Error(`HTTP ${res.status}`), {
      status: res.status,
      data
    })
    throw httpError
  }

  return res.json()
}

/**
 * Render an upstream error body into a short, readable suffix so the actual
 * validation message reaches the caller instead of being swallowed. Returns ""
 * when there's nothing useful (empty object / null).
 */
function formatErrorBody (data) {
  if (data === undefined || data === null) return ''
  if (typeof data === 'string') return data.trim() ? ` — ${data.trim()}` : ''
  if (typeof data === 'object') {
    const obj = data
    if (Object.keys(obj).length === 0) return ''
    // Combine the headline (message/error) with the specific reason
    // (details/detail/errors) — the Work API puts the useful part in `details`,
    // e.g. { error: "Unprocessable Entity", details: "must have required property 'endDate'" }.
    const asText = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
    const parts = []
    const headline = obj.message ?? obj.error
    const reason = obj.details ?? obj.detail ?? obj.errors
    if (headline !== undefined) parts.push(asText(headline))
    if (reason !== undefined) parts.push(asText(reason))
    return parts.length ? ` — ${parts.join(': ')}` : ` — ${JSON.stringify(obj)}`
  }
  return ` — ${String(data)}`
}

export function handleWorkApiError (error) {
  if (error instanceof Error) {
    const e = error
    if (e.status !== undefined) {
      const body = formatErrorBody(e.data)
      switch (e.status) {
        case 400: return `Error: Bad request${body}`
        case 401: return "Error: Unauthorized. Use 'auth_logout' then 'auth_login' to re-authenticate."
        case 403: return "Error: Forbidden — you don't have access to this resource on the active network."
        case 404: return 'Error: Resource not found. Double-check the ID.'
        case 422: return `Error: Unprocessable request (422 — the API rejected the parameters)${body}`
        case 429: return 'Error: Rate limit hit. Wait a moment then retry.'
        case 500: return 'Error: Work API server error. Try again later.'
        default: return `Error: API returned status ${e.status}${body}`
      }
    }
    if (e.code === 'TIMEOUT') return 'Error: Request timed out.'
    if (e.code === 'ECONNREFUSED') return 'Error: Cannot reach Work API. Is it running?'
    return `Error: ${e.message}`
  }
  return `Error: ${String(error)}`
}

/**
 * Fields that are large content blobs — stripped from list responses to keep
 * token counts manageable. Full details are available via individual get_* tools.
 */
const HEAVY_FIELDS = new Set([
  'html', 'css', 'content', 'schema', 'fields', 'config', 'settings', 'body', 'template'
])

function stripHeavyFields (item) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => !HEAVY_FIELDS.has(key))
  )
}

/**
 * Strip heavy content fields from list responses.
 * Handles bare arrays and objects that contain one array property (e.g. { templates: [...], total: N }).
 */
export function stripListItems (data) {
  if (Array.isArray(data)) return data.map(stripHeavyFields)
  if (typeof data === 'object' && data !== null) {
    const obj = data
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key])) {
        return { ...obj, [key]: (obj[key]).map(stripHeavyFields) }
      }
    }
  }
  return data
}

/**
 * Standard envelope returned by every list_* tool.
 * Items are projected to a minimal field set to keep responses small.
 */
;

// Status-ish fields worth surfacing in a list projection (at most 2 are kept).
const STATUS_FIELDS = ['status', 'is_active', 'active', 'enabled', 'state', 'archived']

/** Resolve a possibly-dotted field path ("params.zoneId") against a row.
 * Returns `undefined` when any segment is missing — callers distinguish a real
 * undefined value from "path not present" via `has`. */
function resolvePath (obj, path) {
  if (!path.includes('.')) return path in obj ? { has: true, value: obj[path] } : { has: false, value: undefined }
  let node = obj
  for (const seg of path.split('.')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node) || !(seg in (node))) {
      return { has: false, value: undefined }
    }
    node = (node)[seg]
  }
  return { has: true, value: node }
}

function projectListItem (item, extraFields) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return item
  const obj = item

  // Escape hatch: `fields: ['*']` returns the full row — but still minus the heavy
  // content blobs (html/css/schema/…), which belong in the per-entity get_* tools,
  // never in a list. listEnvelopeToText still caps overall response size.
  if (extraFields.includes('*')) return stripHeavyFields(obj)

  const keep = []
  for (const base of ['id', 'name']) {
    if (base in obj) keep.push(base)
  }
  let statusAdded = 0
  for (const s of STATUS_FIELDS) {
    if (statusAdded >= 2) break
    if (s in obj) { keep.push(s); statusAdded++ }
  }
  const out = {}
  for (const k of keep) out[k] = obj[k]
  // Dotted paths ("params.zoneId") project the leaf under its dotted key — that is
  // what makes a whole-network sweep affordable: pulling params.zoneId instead of
  // params can be two orders of magnitude smaller on rows with runaway arrays.
  for (const f of extraFields) {
    if (f in out) continue
    const { has, value } = resolvePath(obj, f)
    if (has) out[f] = value
  }
  return out
}

/**
 * Requested fields that matched NO row. A silently-absent field reads as "this row
 * has no such data" when it actually means "you asked for the wrong path" — the
 * quiet failure mode of `fields`.
 *
 * Scope matters: this is evaluated over every row FETCHED (the whole collection on
 * the full-set path), not over the returned page. A sparse-but-real field — e.g.
 * `exceptParams.zoneId`, which most ad groups don't carry — can easily be absent
 * from all 100 rows of one page while being perfectly valid. Flagging that would
 * fire a false "your path is wrong" mid-sweep, which is worse than the silence it
 * replaced. Across a whole collection, a path matching nothing really is wrong.
 */
function unmatchedFields (rows, extraFields) {
  if (extraFields.includes('*')) return []
  // An EMPTY collection would flag every requested field, including obviously-valid
  // ones — vacuously true and actively misleading, since "no row carries this path"
  // reads as "your path is wrong" when the truth is "there are no rows". Field-found
  // on network 6s31vy (Lincx Sandbox, 0 ads), which flagged both params.zoneId and
  // adGroupId. No rows means no evidence either way.
  if (rows.length === 0) return []
  return extraFields.filter((f) => !rows.some((it) =>
    it !== null && typeof it === 'object' && !Array.isArray(it) && resolvePath(it, f).has))
}

/**
 * Pull the items array and a total count (when the API provides one) out of an
 * unknown list response. Handles bare arrays and objects with one array property
 * (e.g. { items: [...], total: N } or { data: [...] }).
 */
function extractItemsAndTotal (data) {
  if (Array.isArray(data)) return { items: data, total: null }
  if (typeof data === 'object' && data !== null) {
    const obj = data
    let total = null
    for (const k of ['total', 'totalCount', 'total_count', 'count']) {
      if (typeof obj[k] === 'number') { total = obj[k]; break }
    }
    for (const k of Object.keys(obj)) {
      if (Array.isArray(obj[k])) return { items: obj[k], total }
    }
  }
  return { items: [], total: null }
}

/**
 * Build the standard list envelope: minimal-field items plus pagination metadata.
 *
 * Two upstream behaviors are handled:
 *  - Full-set (every real Work API list endpoint): the API ignores limit/offset and
 *    returns ALL rows with no total field. We slice the [offset, offset+limit) window
 *    ourselves so pagination actually works, and `total` is the real, stable row count.
 *  - Paginated: the API returns one page plus a `total` field (total > page length).
 *    We trust it and don't re-slice.
 *
 * Detecting full-set as "no total, or total <= rows returned" means a stray count
 * field equal to the row count still takes the slice path (we have everything).
 */
export function buildListEnvelope (
  data,
  opts
) {
  const { limit, offset, fields = [] } = opts
  const { items, total } = extractItemsAndTotal(data)

  const upstreamPaginated = total !== null && total > items.length
  const page = upstreamPaginated ? items : items.slice(offset, offset + limit)
  const realTotal = upstreamPaginated ? total : items.length

  const projected = page.map((it) => projectListItem(it, fields))
  const hasMore = offset + page.length < realTotal
  // Judge the field paths against everything we fetched, not just this page —
  // upstreamPaginated is the only case where the page IS all we have.
  const unknown = unmatchedFields(upstreamPaginated ? page : items, fields)
  return {
    items: projected,
    total: realTotal,
    limit,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + page.length : null,
    ...(unknown.length > 0 ? { unknown_fields: unknown } : {})
  }
}

/**
 * Serialize a list envelope to compact JSON, fitting it under CHARACTER_LIMIT by
 * DROPPING trailing items — never by slicing the string. This keeps the output
 * valid JSON (the old character-slice in truncateIfNeeded cut mid-structure and
 * produced unparseable responses) while keeping pagination metadata honest:
 * has_more/next_offset are rewritten so the caller can fetch the dropped items.
 */
export function listEnvelopeToText (env) {
  if (JSON.stringify(env).length <= CHARACTER_LIMIT) return JSON.stringify(env)

  const fetched = env.items.length
  const kept = [...env.items]
  // Reserve headroom for the larger truncated-envelope metadata.
  while (kept.length > 0) {
    const candidate = { ...env, items: kept, has_more: true }
    if (JSON.stringify(candidate).length <= CHARACTER_LIMIT - 200) break
    kept.pop()
  }

  // A single row bigger than the whole budget leaves kept empty. Returning
  // next_offset = offset then makes the documented "page until next_offset is
  // absent" walk loop forever on that row, which is worse than any truncation:
  // the caller can never reach row offset+1. Replace the poison row with an
  // identifying stub and advance past it, so the walk always terminates and the
  // skipped id is named rather than silently swallowed.
  const oversized = kept.length === 0 && fetched > 0
  if (oversized) {
    const first = env.items[0]
    kept.push({
      id: first?.id,
      _omitted: "This row alone exceeds the response budget; fetch it with get_<entity> or a narrower 'fields'."
    })
  }

  const next = env.offset + (oversized ? 1 : kept.length)
  const result = {
    ...env,
    items: kept,
    has_more: true,
    next_offset: next,
    truncated: {
      returned: oversized ? 0 : kept.length,
      fetched,
      ...(oversized ? { skipped_oversized: (env.items[0])?.id } : {}),
      reason: oversized
        ? `One row exceeds the ${CHARACTER_LIMIT}-char budget on its own, so no full item fit. Its id is returned as a stub and next_offset advances past it — request offset=${next} to continue, or pass a narrower 'fields'.`
        : `Response exceeded ${CHARACTER_LIMIT} chars. Returned ${kept.length} of ${fetched} fetched items; request offset=${next} to continue, or pass a narrower 'fields'.`
    }
  }
  return JSON.stringify(result)
}

export function truncateIfNeeded (text, total) {
  if (text.length <= CHARACTER_LIMIT) return text
  const suffix = total
    ? `\n\n[Truncated — ${total} total. Use 'limit'/'offset' to paginate.]`
    : '\n\n[Truncated. Use pagination parameters to see more.]'
  return text.slice(0, CHARACTER_LIMIT) + suffix
}

/**
 * Serialize a single entity to valid JSON under CHARACTER_LIMIT.
 *
 * The old path (`truncateIfNeeded(JSON.stringify(entity))`) sliced the JSON
 * string mid-structure when an entity was too big (e.g. a template's html/css),
 * producing UNPARSEABLE output below the 30k tool-guard threshold. This instead
 * elides the largest STRING leaves one at a time, largest-first, until the result
 * fits — and ALWAYS emits valid JSON. A `_truncated` note lists the elided field
 * paths (e.g. `html`, `entity.css`) so the caller knows what was dropped and can
 * fetch full fidelity via the entity's resource URI (`lincx://{entity}/{id}`) or
 * a more specific tool (e.g. `get_template_version`).
 *
 * Invariant: `JSON.parse(fitEntityToText(x))` never throws, for any input.
 */
export function fitEntityToText (data) {
  let text = JSON.stringify(data ?? null)
  if (text.length <= CHARACTER_LIMIT) return text

  // Reserve headroom for the _truncated note appended after eliding.
  const budget = CHARACTER_LIMIT - 400
  // Deep clone — data came from JSON (no cycles/functions), so this is safe.
  const clone = JSON.parse(text)

  const leaves = []
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        const p = `${path}[${i}]`
        if (typeof v === 'string') leaves.push({ parent: node, key: i, path: p, length: v.length, marker: `[elided: ${v.length} chars]` })
        else if (v && typeof v === 'object') walk(v, p)
      })
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const p = path ? `${path}.${k}` : k
        if (typeof v === 'string') {
          leaves.push({ parent: node, key: k, path: p, length: v.length, marker: `[elided: ${v.length} chars]` })
        } else if (Array.isArray(v)) {
          // A big array of SMALL strings (field-found: an ad group with 20k zone ids
          // in params.zoneId, 232KB) has no large string leaf to shed, so a
          // string-only pass could not shrink it and the caller got no data at all.
          // Shed the array as a unit, keeping its size visible.
          const len = JSON.stringify(v).length
          leaves.push({ parent: node, key: k, path: p, length: len, marker: `[elided: ${v.length} items, ${len} chars]` })
          walk(v, p)
        } else if (v && typeof v === 'object') walk(v, p)
      }
    }
  }
  walk(clone, '')
  leaves.sort((a, b) => b.length - a.length)

  // Elide the largest leaf, re-measure, repeat — never over-elide in a batch.
  // Shedding a parent array first makes its own children unreachable; harmless,
  // since assigning into the detached child only mutates garbage.
  const elided = []
  for (const leaf of leaves) {
    (leaf.parent)[leaf.key] = leaf.marker
    elided.push(leaf.path)
    text = JSON.stringify(clone)
    if (text.length <= budget) break
  }

  const note = {
    elided,
    reason: `Response exceeded ${CHARACTER_LIMIT} chars; the largest string and array fields were elided (the rest of the entity is intact). Fetch full content via the entity's resource URI (lincx://{entity}/{id}) or a more specific tool.`
  }

  if (clone && typeof clone === 'object' && !Array.isArray(clone)) {
    (clone)._truncated = note
    text = JSON.stringify(clone)
    if (text.length <= CHARACTER_LIMIT) return text
    // Eliding strings wasn't enough (huge non-string structure) — last-resort note.
    return JSON.stringify({ _truncated: { ...note, partial: true } })
  }
  // Array/primitive root — wrap so the note can ride along as valid JSON.
  const wrapped = JSON.stringify({ data: clone, _truncated: note })
  return wrapped.length <= CHARACTER_LIMIT ? wrapped : JSON.stringify({ _truncated: { ...note, partial: true } })
}
