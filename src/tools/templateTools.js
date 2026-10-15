/* eslint-disable camelcase -- Tool input / output fields and OAuth params are snake_case on the wire: protocol, not style. */
/**
 * tools/templateTools.js
 *
 * list_templates    — GET /api/templates (paginated)
 * get_template      — GET /api/templates/{id}
 * get_template_versions — GET /api/templates/{id}/versions
 * get_template_version  — GET /api/templates/{id}/versions/{version}
 * create_template   — POST /api/templates (write)
 * update_template_content — POST /api/templates/{id}/patch (write)
 */

import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { CHARACTER_LIMIT } from '../constants.js'
import { workApiRequest, handleWorkApiError, fitEntityToText, stripListItems, buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'
import { paginationShape, includeShape, getEntityWithIncludes, requiredNetworkIdShape, entityId } from './_shared.js'

// Combined html + css ceiling. /mcp bodies are capped at 100kb (readBody) and
// JSON-RPC escaping inflates markup; a large real template (pddd6d, ~25k chars)
// is ~28KB on the wire, so this leaves headroom while failing an outlier with a
// message that names the limit instead of a transport error that names nothing.
const MAX_CONTENT_CHARS = 80_000

export function registerTemplateTools (server) {
  // ── list_templates ──────────────────────────────────────────────────────────
  server.registerTool('list_templates', {
    title: 'List Templates',
    description: `List ad templates available on the specified network.

Returns an array of template objects. Each template has an id, name, and metadata.
Use 'get_template' to fetch the full HTML + CSS source of a specific template.
Pass publisherId to enumerate one publisher's templates exhaustively; without it, the whole network is listed.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      publisherId: z.string().optional().describe('Only templates for this publisher'),
      ...paginationShape
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, offset, fields, publisherId, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const params = { limit, offset }
      if (publisherId !== undefined) params.publisherId = publisherId
      const data = await workApiRequest(v.session, 'GET', '/api/templates', { networkId: network_id, params })
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_template ────────────────────────────────────────────────────
  server.registerTool('get_template', {
    title: 'Get Template',
    description: `Fetch full details of a single template by ID, including its HTML and CSS source.

Returns the template object with id, name, html, css, creativeAssetGroupId, and version info.
A large template's html comes back as "[elided: N chars]". Pass part: 'html' or 'css' to get that one field whole, as raw text — always do this before editing a template.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: z.string().describe('Template ID'),
      ...includeShape,
      part: z.enum(['html', 'css']).optional().describe('Return only this field, raw and unelided (include is ignored)')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, include, part, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      if (part) {
        const res = await workApiRequest(v.session, 'GET', `/api/templates/${id}`)
        const field = (res?.data ?? res)?.[part] ?? ''
        if (field.length > CHARACTER_LIMIT) return text(`Error: template ${id} ${part} is ${field.length} chars — over the ${CHARACTER_LIMIT}-char response limit, so it can't be returned whole and must not be edited through this server.`)
        return text(field)
      }
      const data = await getEntityWithIncludes(v.session, '/api/templates', id, include)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_template_versions ───────────────────────────────────────────────────
  server.registerTool('get_template_versions', {
    title: 'Get Template Versions',
    description: `List all saved versions of a template.

Returns version numbers, timestamps, and who created each version.
Use 'get_template_version' to fetch the HTML + CSS of a specific version.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: z.string().describe('Template ID')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const data = await workApiRequest(v.session, 'GET', `/api/templates/${id}/versions`)
      return { content: [{ type: 'text', text: fitEntityToText(stripListItems(data)) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })

  // ── get_template_version ────────────────────────────────────────────────────
  server.registerTool('get_template_version', {
    title: 'Get Template Version',
    description: `Fetch the HTML + CSS source of a specific version of a template.

Use 'get_template_versions' first to see available version numbers.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: z.string().describe('Template ID'),
      version: z.number().int().min(1).describe('Version number')
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, version, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }
    try {
      const data = await workApiRequest(v.session, 'GET', `/api/templates/${id}/versions/${version}`)
      return { content: [{ type: 'text', text: fitEntityToText(data) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}

/**
 * Why a template's mustache would break at serve time, or null when it is sound.
 * Upstream accepts any non-empty html, so an unbalanced {{#ads}} reaches every
 * page carrying the zone before anyone sees it. Checks section balance/order and
 * unclosed `{{` only — not which variables exist (that needs the CAG schema).
 */
export function mustacheError (html) {
  const stack = []
  let outside = ''
  let last = 0
  let i = 0
  let cEnd = -2 // first `}}` at or after the cursor, for `{{! … }}` comments (may contain `}`) — memoised like `brace`
  let brace = -2 // first `}` at or after the cursor — memoised, so an unclosed `{{{{…` is one pass, not a rescan per opener
  while ((i = html.indexOf('{{', i)) !== -1) {
    if (html[i + 2] === '!') {
      if (cEnd < i + 3 && cEnd !== -1) cEnd = html.indexOf('}}', i + 3)
      if (cEnd === -1) { i += 2; continue }
      outside += html.slice(last, i)
      last = i = cEnd + 2
      continue
    }
    if (brace < i + 2 && brace !== -1) brace = html.indexOf('}', i + 2)
    const triple = html[i + 2] === '{'
    // a tag is `{{` + body without `}` + `}}` (or `{{{`…`}}}`); anything else leaves the `{{` in `outside`
    const end = triple ? html.indexOf('}}}', i + 3) : brace
    const closed = triple
      ? end !== -1 && !html.slice(i + 3, end).includes('}')
      : brace !== -1 && html[brace + 1] === '}'
    if (!closed) { i += 2; continue }
    outside += html.slice(last, i)
    if (triple) { i = last = end + 3; continue } // {{{triple}}} is a plain variable
    const body = html.slice(i + 2, brace).trim()
    last = i = brace + 2
    const kind = body[0]
    if (kind === '=') return null // ponytail: custom delimiters left unchecked; no template uses them
    const name = body.slice(1).trim()
    if (kind === '#' || kind === '^') stack.push(name)
    if (kind === '/') {
      const open = stack.pop()
      if (open === undefined) return `{{/${name}}} closes a section that was never opened`
      if (open !== name) return `{{/${name}}} closes {{#${open}}} — sections must close in the order they open`
    }
  }
  outside += html.slice(last)
  if (stack.length) return `{{#${stack.at(-1)}}} is never closed`
  if (outside.includes('{{')) return 'a {{ tag is never closed with }}'
  return null
}

const text = (t) => ({ content: [{ type: 'text', text: t }] })

/**
 * The field carrying fitEntityToText's elision marker, or null. get_template
 * elides a large template's html (pddd6d: "[elided: 16772 chars]"), and that
 * string passes every other check — so "copy template X" would otherwise save
 * the marker as the template.
 */
export function elidedField (fields) {
  return Object.keys(fields).find(k => fields[k]?.includes('[elided: ')) ?? null
}

// A comment whose WHOLE body stands in for code the model did not write out (an ordinary
// `/* fill remaining space */` must pass — a live template with one has to stay editable). On update
// the stored template is replaced wholesale and is live on save, so "<!-- rest
// unchanged -->" silently deletes the rest.
const PLACEHOLDER_BODY = /^\s*(?:\.{2,}|…)\s*$|^[\s.…]*(?:(?:the )?rest(?: of (?:the )?(?:file|code|css|html|template|styles?|content|page|markup))?(?: (?:is |stays |remains )?(?:unchanged|the same))?|(?:the )?remaining(?: (?:code|css|html|styles?|content|markup))?|(?:code |css |html |styles? |content )?(?:is |stays |remains )?unchanged|same as (?:before|above|original)|omitted|truncated)[\s.…]*$/i

/**
 * Split `src` on `open…close` comments in one linear pass (indexOf, no
 * backtracking — a lazy regex rescans to the end for every unclosed opener,
 * quadratic on an 80k-char `<!--<!--…`). `bare` is src without the comments;
 * `unclosed` is true when an opener never finds its closer.
 */
function stripComments (src, open, close) {
  const bodies = []
  let bare = ''
  let at = 0
  for (;;) {
    const i = src.indexOf(open, at)
    if (i === -1) return { bare: bare + src.slice(at), bodies, unclosed: false }
    const j = src.indexOf(close, i + open.length)
    bare += src.slice(at, i)
    if (j === -1) return { bare, bodies, unclosed: true }
    bodies.push(src.slice(i + open.length, j))
    at = j + close.length
  }
}

/**
 * Why html/css would break the page or lose content once live, or null. Runs
 * after the size/elision/mustache checks and covers what an LLM actually gets
 * wrong: code fences, control characters, placeholder comments, and markup
 * left open (a stray `<!--`, `<script>` or `{` swallows the publisher's page).
 */
export function contentError ({ html, css }) {
  const fields = { html, css }
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (/^\s*```/.test(v)) return `${k} is wrapped in a markdown code fence — send the raw source, not a fenced block`
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return `${k} contains control characters`
    if (!v.isWellFormed()) return `${k} contains a lone UTF-16 surrogate (broken emoji or escape)`
    const [open, close] = k === 'html' ? ['<!--', '-->'] : ['/*', '*/']
    if (stripComments(v, open, close).bodies.some(b => PLACEHOLDER_BODY.test(b))) return `${k} contains a placeholder comment standing in for omitted code — send the complete source`
  }
  if (html !== undefined) {
    const { bare, unclosed } = stripComments(html, '<!--', '-->')
    if (unclosed) return 'html has a "<!--" that is never closed with "-->" — it would hide the rest of the page'
    for (const tag of ['script', 'style']) {
      const open = (bare.match(new RegExp(`<${tag}\\b`, 'gi')) ?? []).length
      const close = (bare.match(new RegExp(`</${tag}\\s*>`, 'gi')) ?? []).length
      if (open !== close) return `html has ${open} <${tag}> and ${close} </${tag}> — every one must be closed`
    }
  }
  if (css !== undefined) {
    if (/<\/style/i.test(css)) return 'css contains "</style" — it would close the page\'s style block and leak the rest as markup'
    const { bare: noComments, unclosed } = stripComments(css, '/*', '*/')
    if (unclosed) return 'css has a "/*" comment that is never closed'
    const bare = noComments.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, '')
    let depth = 0
    for (const c of bare) {
      if (c === '{') depth++
      if (c === '}' && --depth < 0) return 'css has a "}" with no matching "{"'
    }
    if (depth) return `css has ${depth} unclosed "{"`
  }
  return null
}

/**
 * A parent the template will hang off must exist, belong to this network, and
 * be live. Upstream checks the publisher's network but NOT the CAG's
 * (integrity-check.js drops creativeAssetGroup before matching ids), so without
 * this a template can be bound to another network's CAG.
 */
async function parentError (session, path, label, id, networkId) {
  let res
  try {
    res = await workApiRequest(session, 'GET', `${path}/${id}`)
  } catch (err) {
    if (err.status === 404) return `Error: ${label} ${id} not found.`
    return handleWorkApiError(err)
  }
  const entity = res?.data ?? res
  if (entity?.networkId !== networkId) return `Error: ${label} ${id} belongs to network ${entity?.networkId}, not ${networkId}.`
  if (entity.archived) return `Error: ${label} ${id} is archived — a template can't be created under it.`
  return null
}

export function registerTemplateWriteTools (server) {
  server.registerTool('create_template', {
    title: 'Create Template',
    description: `Create a new ad template (HTML + CSS) under a publisher, bound to a creative asset group (CAG).

The CAG defines the fields ads provide to the template's mustache variables ({{#ads}}…{{/ads}}); use 'get_creative_asset_group' to see them.
Before sending, the server checks: ids are well-formed, name and html are non-blank, mustache sections are balanced, html/css are raw source (no code fence, control characters, placeholder comments, or unclosed comment/script/style/brace), content is under ${MAX_CONTENT_CHARS} chars, and the publisher and CAG both exist in network_id and are not archived.
Returns { id, name, version } — not the html/css you sent. A new template is not served anywhere until a zone is pointed at it.
Not idempotent: on a timeout, check 'list_templates' with publisherId for the name before retrying, or you may create a duplicate.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      publisherId: entityId('publisherId').describe('Publisher that owns the template (must be in network_id)'),
      creativeAssetGroupId: entityId('creativeAssetGroupId').describe('CAG whose fields the template renders (must be in network_id)'),
      // eslint-disable-next-line no-control-regex
      name: z.string().trim().min(1, 'name must not be blank').max(200).refine(s => !/[\u0000-\u001f\u007f]/.test(s), 'name must not contain control characters or newlines').describe('Template name'),
      html: z.string().refine(s => s.trim() !== '', 'html must not be blank').describe('Template HTML — mustache, ads rendered inside {{#ads}}…{{/ads}}'),
      css: z.string().optional().describe('Template CSS'),
      tieringEnabled: z.boolean().optional().describe('Let serving return more than adFeedCount ads so a beforeLoad script can tier them')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ network_id, publisherId, creativeAssetGroupId, name, html, css, tieringEnabled }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return text("Error: Not authenticated. Use 'auth_login' first.")

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return text(`Error: ${v.error}`)

    const size = html.length + (css?.length ?? 0)
    if (size > MAX_CONTENT_CHARS) return text(`Error: html + css is ${size} chars; the limit is ${MAX_CONTENT_CHARS}.`)
    const elided = elidedField({ html, css })
    if (elided) return text(`Error: ${elided} contains an "[elided: …]" marker — it was copied from a truncated get_template response, not the real source. Fetch the full content first.`)
    const broken = mustacheError(html)
    if (broken) return text(`Error: html mustache is invalid — ${broken}.`)
    const unsound = contentError({ html, css })
    if (unsound) return text(`Error: ${unsound}.`)

    const parents = await Promise.all([
      parentError(v.session, '/api/publishers', 'publisher', publisherId, network_id),
      parentError(v.session, '/api/creative-asset-groups', 'creative asset group', creativeAssetGroupId, network_id)
    ])
    const refused = parents.filter(Boolean)
    if (refused.length) return text(refused.join('\n'))

    const body = { networkId: network_id, publisherId, creativeAssetGroupId, name, html }
    if (css !== undefined) body.css = css
    if (tieringEnabled !== undefined) body.tieringEnabled = tieringEnabled

    try {
      // Creates write version 1 to GCS as well as Redis — slower than a read.
      const res = await workApiRequest(v.session, 'POST', '/api/templates', { body, timeoutMs: 30_000 })
      const t = res?.data ?? res
      const out = { id: t.id, name: t.name, networkId: t.networkId, publisherId: t.publisherId, creativeAssetGroupId: t.creativeAssetGroupId, version: t.version }
      return text(`Created template ${t.id} (version ${t.version}).\n\n${JSON.stringify(out)}`)
    } catch (err) {
      // upstream commits to Redis before GCS, so a 5xx can leave the template behind just as a timeout can
      if (err.code === 'TIMEOUT' || err.status >= 500) return text(`Error: create ${err.code === 'TIMEOUT' ? 'timed out' : `failed (${err.status})`} — the template MAY have been created. Check 'list_templates' with publisherId ${publisherId} for "${name}" before retrying.`)
      if (err.status === 403) return text(`Error: Forbidden — your user can't create templates under publisher ${publisherId} on network ${network_id}.`)
      return text(handleWorkApiError(err))
    }
  })

  server.registerTool('update_template_content', {
    title: 'Update Template Content',
    description: `Replace a template's html and/or css. The edit GOES LIVE IMMEDIATELY on every zone using the template (and in zone template tests) — there is no draft or publish step.

Read the current source first with get_template part: 'html' / 'css' — never edit from a get_template response whose html shows "[elided: …]".
Only html and css are editable here. Not editable: creativeAssetGroupId (changing it rewrites every zone using the template), tieringEnabled (changes what serving returns), networkId/publisherId (fixed upstream), name and notes (not content).
Before sending, the server checks: at least one of html/css is given, ids are well-formed, html is non-blank with balanced mustache sections, neither field carries an "[elided: " marker, html/css are raw source (no code fence, control characters, placeholder comments, or unclosed comment/script/style/brace), and content is under ${MAX_CONTENT_CHARS} chars. The template must be in network_id — checked in the same atomic call.
Returns { id, name, version }. Version is assigned upstream: new content gets a new number, but content identical to an earlier version reuses that version's number.`,
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      id: entityId('id').describe('Template ID (must be in network_id)'),
      html: z.string().refine(s => s.trim() !== '', 'html must not be blank').optional().describe('New full template HTML — replaces the stored html'),
      css: z.string().optional().describe('New full template CSS — replaces the stored css; empty string clears it')
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ network_id, id, html, css }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return text("Error: Not authenticated. Use 'auth_login' first.")

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return text(`Error: ${v.error}`)

    if (html === undefined && css === undefined) return text('Error: pass html, css, or both — there is nothing to update.')
    const size = (html?.length ?? 0) + (css?.length ?? 0)
    if (size > MAX_CONTENT_CHARS) return text(`Error: html + css is ${size} chars; the limit is ${MAX_CONTENT_CHARS}.`)
    const elided = elidedField({ html, css })
    if (elided) return text(`Error: ${elided} contains an "[elided: …]" marker — it was copied from a truncated get_template response, not the real source. Re-read it with get_template part: '${elided}'.`)
    const broken = html !== undefined && mustacheError(html)
    if (broken) return text(`Error: html mustache is invalid — ${broken}.`)
    const unsound = contentError({ html, css })
    if (unsound) return text(`Error: ${unsound}.`)

    try {
      const res = await workApiRequest(v.session, 'POST', `/api/templates/${id}/patch`, { body: templatePatch(network_id, { html, css }), timeoutMs: 30_000 })
      const t = res?.data ?? res
      return text(`Updated template ${t.id} — now version ${t.version}. Live on every zone using it.\n\n${JSON.stringify({ id: t.id, name: t.name, version: t.version })}`)
    } catch (err) {
      // fast-json-patch errors carry the operation and the whole stored doc in
      // their message, and upstream returns it as `details` — passed through,
      // that would dump the template (or another network's) into context.
      const details = String(err.data?.details ?? '')
      if (err.status === 422 && details.startsWith('Test operation failed')) return text(`Error: template ${id} is not in network ${network_id}.`)
      if (err.status === 422 && details.includes('\n')) err.data = { ...err.data, details: details.split('\n')[0] }
      // Redis is written before GCS upstream, so a 5xx can leave the edit applied
      if (err.code === 'TIMEOUT' || err.status >= 500) return text(`Error: update ${err.code === 'TIMEOUT' ? 'timed out' : `failed (${err.status})`} — it MAY have been applied. Check 'get_template_versions' for ${id} before retrying.`)
      return text(handleWorkApiError(err))
    }
  })
}

/**
 * The JSON Patch update_template_content sends. Built here from a closed set
 * of fields — raw ops from the model are never accepted. `test /networkId`
 * scopes the edit to network_id atomically (no pre-flight GET); `add` for css
 * because it is optional upstream and `replace` on a missing path throws.
 */
export function templatePatch (networkId, { html, css }) {
  const ops = [{ op: 'test', path: '/networkId', value: networkId }]
  if (html !== undefined) ops.push({ op: 'replace', path: '/html', value: html })
  if (css !== undefined) ops.push({ op: 'add', path: '/css', value: css })
  return ops
}
