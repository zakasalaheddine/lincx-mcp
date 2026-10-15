import test from 'ava'
import esmock from 'esmock'

import { templatePatch } from '../tools/templateTools.js'
import { REAL_HTML } from './helpers/templateFixture.js'

/**
 * update_template_content edits a template that is live on every zone using
 * it. What must never happen: a malformed, truncated or wrongly-scoped edit
 * reaching POST /api/templates/{id}/patch. Every refusal test therefore asserts
 * the mock saw NO POST, not just the error text.
 */

const NET = 'svce6t'
const TPL = 'pddd6d'

async function load ({ post, get } = {}) {
  const calls = []
  const mod = await esmock('../tools/templateTools.js', {}, {
    '../services/workApi.js': {
      workApiRequest: async (_s, method, path, opts) => {
        calls.push({ method, path, opts })
        if (method === 'GET') return get()
        if (post) return post(opts)
        return { data: { id: TPL, name: 'Listicle', networkId: NET, html: 'stored', css: 'stored', version: 7 } }
      }
    },
    '../services/sessionManager.js': {
      resolveLincxSession: async () => ({ auth_token: 'jwt', email: 'a@b.c' }),
      validateSession: async (a) => ({ valid: true, session: a })
    }
  })
  const tools = {}
  const schemas = {}
  const register = { registerTool: (name, def, h) => { tools[name] = h; schemas[name] = def.inputSchema } }
  mod.registerTemplateTools(register)
  mod.registerTemplateWriteTools(register)
  const posts = () => calls.filter(c => c.method === 'POST')
  return { tools, schema: schemas.update_template_content, calls, posts }
}

const args = (over = {}) => ({ network_id: NET, id: TPL, ...over })
const run = async (env, over) => (await env.tools.update_template_content(args(over), {})).content[0].text

test('templatePatch builds exactly the ops for html-only, css-only and both', t => {
  const scope = { op: 'test', path: '/networkId', value: NET }
  t.deepEqual(templatePatch(NET, { html: '<a/>' }), [scope, { op: 'replace', path: '/html', value: '<a/>' }])
  t.deepEqual(templatePatch(NET, { css: '' }), [scope, { op: 'add', path: '/css', value: '' }])
  t.deepEqual(templatePatch(NET, { html: '<a/>', css: '.a{}' }), [
    scope, { op: 'replace', path: '/html', value: '<a/>' }, { op: 'add', path: '/css', value: '.a{}' }
  ])
})

test('no op ever targets a path other than networkId/html/css', t => {
  const ops = templatePatch(NET, { html: 'x', css: 'y', creativeAssetGroupId: 'cag001', tieringEnabled: true, name: 'n' })
  t.deepEqual(ops.map(o => o.path), ['/networkId', '/html', '/css'])
})

test('unsound content is refused before any POST', async t => {
  const env = await load()
  for (const over of [{ html: '<a/><!-- rest unchanged -->' }, { css: '.a{' }, { html: '```html\n<a/>\n```' }]) {
    t.regex(await run(env, over), /^Error: /)
  }
  t.is(env.posts().length, 0)
})

test('the schema rejects non-content fields, raw ops and bad ids', async t => {
  const { schema } = await load()
  const bad = {
    creativeAssetGroupId: { creativeAssetGroupId: 'cag001' },
    tieringEnabled: { tieringEnabled: true },
    name: { name: 'x' },
    version: { version: 3 },
    'raw ops': { ops: [{ op: 'replace', path: '/creativeAssetGroupId', value: 'cag001' }] },
    'path-injection id': { id: '../zones/abcdef' },
    'uppercase id': { id: 'PDDD6D' },
    'bad network_id': { network_id: 'svce6t/..' },
    'whitespace html': { html: ' \n\t ' }
  }
  for (const [label, over] of Object.entries(bad)) {
    t.false(schema.safeParse(args({ html: REAL_HTML, ...over })).success, label)
  }
  t.true(schema.safeParse(args({ css: '' })).success, 'empty css clears it')
})

test('happy path POSTs the patch to /patch and does not echo content', async t => {
  const env = await load()
  const out = await run(env, { html: REAL_HTML, css: '.a{}' })
  const [post] = env.posts()
  t.is(post.path, `/api/templates/${TPL}/patch`)
  t.deepEqual(post.opts.body, templatePatch(NET, { html: REAL_HTML, css: '.a{}' }))
  t.true(out.startsWith(`Updated template ${TPL} — now version 7.`))
  t.deepEqual(JSON.parse(out.split('\n\n')[1]), { id: TPL, name: 'Listicle', version: 7 })
  t.false(out.includes('stored'), 'html/css must not be echoed back')
})

const refusals = {
  'neither field': [{}, /nothing to update/],
  oversize: [{ html: '{{#ads}}' + 'x'.repeat(80_000) + '{{/ads}}' }, /limit is 80000/],
  'html copied from a truncated read': [{ html: '[elided: 16772 chars]' }, /html contains an "\[elided: …\]" marker.*part: 'html'/],
  'css copied from a truncated read': [{ css: '[elided: 8400 chars]' }, /css contains an "\[elided: …\]" marker/],
  'unbalanced mustache': [{ html: '{{#ads}}<div/>' }, /mustache is invalid — \{\{#ads\}\} is never closed/]
}

for (const [label, [over, expected]] of Object.entries(refusals)) {
  test(`refuses without POSTing: ${label}`, async t => {
    const env = await load()
    t.regex(await run(env, over), expected)
    t.is(env.posts().length, 0)
  })
}

// Real upstream shape: create-endpoint.js wraps the fast-json-patch error in a
// ValidationError, and the error handler returns its message as `details` —
// which includes the operation and the WHOLE stored document.
const patchError = (msg) => Object.assign(new Error('HTTP 422'), {
  status: 422,
  data: { error: 'Unprocessable Entity', details: `${msg}\nname: X\nindex: 0\noperation: {"value":"<html>"}\ntree: {"html":"OTHER NETWORK SOURCE"}` }
})

test('a failed test /networkId reads as wrong network and leaks no document', async t => {
  const env = await load({ post: () => { throw patchError('Test operation failed') } })
  const out = await run(env, { html: REAL_HTML })
  t.is(out, `Error: template ${TPL} is not in network ${NET}.`)
})

test('other patch errors pass through cut to their first line', async t => {
  const env = await load({ post: () => { throw patchError('Cannot perform the operation at a path that does not exist') } })
  const out = await run(env, { html: REAL_HTML })
  t.regex(out, /422.*Cannot perform the operation/)
  t.false(out.includes('OTHER NETWORK SOURCE'))
})

test('upstream 400 (archived template) passes through verbatim', async t => {
  const env = await load({
    post: () => { throw Object.assign(new Error('HTTP 400'), { status: 400, data: { error: 'Bad Request', details: 'Template is archived' } }) }
  })
  t.regex(await run(env, { html: REAL_HTML }), /Bad request — Bad Request: Template is archived/)
})

test('timeout says the edit may have been applied', async t => {
  const env = await load({ post: () => { throw Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' }) } })
  t.regex(await run(env, { css: '' }), /MAY have been applied.*get_template_versions/)
})

test('a 5xx says the edit may have been applied (Redis is written before GCS)', async t => {
  const env = await load({ post: () => { throw Object.assign(new Error('HTTP 502'), { status: 502 }) } })
  t.regex(await run(env, { css: '' }), /failed \(502\) — it MAY have been applied.*get_template_versions/)
})

test('a live template with ordinary comments can be round-tripped', async t => {
  const env = await load({ post: async () => ({ data: { id: 'pddd6d', name: 'x', version: 2 } }) })
  const out = await run(env, { css: '.a{flex:1} /* fill remaining space */ .t{text-overflow:ellipsis} /* truncated titles */' })
  t.regex(out, /Updated template pddd6d/)
})

// ── get_template part ─────────────────────────────────────────────────────────

const getPart = async (env, part) =>
  (await env.tools.get_template({ network_id: NET, id: TPL, part }, {})).content[0].text

test('get_template part returns the one field raw and whole', async t => {
  const big = REAL_HTML + '<!--' + 'x'.repeat(16_000) + '-->' // pddd6d-sized html
  const env = await load({ get: () => ({ data: { id: TPL, html: big, css: '.a{}', notes: { history: ['…'] } } }) })
  t.is(await getPart(env, 'html'), big)
  t.is(await getPart(env, 'css'), '.a{}')
})

test('get_template part refuses a field over the response limit instead of eliding it', async t => {
  const env = await load({ get: () => ({ data: { id: TPL, html: 'x'.repeat(40_000) } }) })
  t.regex(await getPart(env, 'html'), /40000 chars — over the \d+-char response limit.*must not be edited/)
})

test('get_template part on a template with no css returns empty text', async t => {
  const env = await load({ get: () => ({ data: { id: TPL, html: '<a/>' } }) })
  t.is(await getPart(env, 'css'), '')
})
