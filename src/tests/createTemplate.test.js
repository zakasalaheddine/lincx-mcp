import test from 'ava'
import esmock from 'esmock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { contentError, mustacheError } from '../tools/templateTools.js'
import { REAL_HTML } from './helpers/templateFixture.js'

/**
 * create_template is the first write tool. What must never happen: a malformed
 * or wrongly-scoped template reaching POST /api/templates. Every refusal test
 * below therefore asserts the mock saw NO POST, not just the error text.
 */

const NET = 'svce6t'
const live = (over = {}) => ({ data: { id: 'x', networkId: NET, ...over } })

test('mustacheError passes a real production template', t => {
  t.is(mustacheError(REAL_HTML), null)
})

test('mustacheError names each way a section breaks', t => {
  t.regex(mustacheError('{{#ads}}<div>{{title}}</div>'), /\{\{#ads\}\} is never closed/)
  t.regex(mustacheError('<div>{{title}}</div>{{/ads}}'), /never opened/)
  t.regex(mustacheError('{{#ads}}{{#cta}}{{/ads}}{{/cta}}'), /closes \{\{#cta\}\}/)
  t.regex(mustacheError('{{#ads}}{{title}{{/ads}}'), /never closed with \}\}/)
  t.regex(mustacheError('{{^empty}}x'), /\{\{#empty\}\} is never closed/)
})

test('contentError passes real source and names each way LLM input goes wrong', t => {
  t.is(contentError({ html: REAL_HTML, css: '.a{color:red}\n/* ok */ .b::after{content:"}"}' }), null)
  t.is(contentError({ css: '' }), null, 'empty css (clear) is fine')
  t.regex(contentError({ html: '```html\n<div/>\n```' }), /code fence/)
  t.regex(contentError({ css: '```css\n.a{}\n```' }), /code fence/)
  t.regex(contentError({ html: '<div>\u0000</div>' }), /control characters/)
  t.regex(contentError({ html: '<div>\ud83d</div>' }), /surrogate/)
  t.regex(contentError({ html: '<div/><!-- rest unchanged -->' }), /placeholder/)
  t.regex(contentError({ css: '.a{} /* ... */' }), /placeholder/)
  t.regex(contentError({ html: '<div/><!-- never closed' }), /never closed with "-->"/)
  t.regex(contentError({ html: '<script>x()' }), /1 <script> and 0 <\/script>/)
  t.regex(contentError({ html: '<style>.a{}' }), /<style>/)
  t.regex(contentError({ css: '.a{color:red' }), /1 unclosed "\{"/)
  t.regex(contentError({ css: '.a{}}' }), /no matching/)
  t.regex(contentError({ css: '.a{} /* open' }), /never closed/)
  t.regex(contentError({ css: '.a{}</style><script>' }), /<\/style/)
})

test('mustacheError and contentError stay linear on adversarial input', t => {
  // Each of these took 0.5–18s on an 80k string with the lazy/backtracking regexes — an
  // event-loop stall for every user of the instance from one tool call.
  const hostile = ['{{'.repeat(40000), '{{{'.repeat(26000), '{{x}'.repeat(20000) + '}}', '<!--'.repeat(20000), '<!--' + 'rest of '.repeat(9000), '/*'.repeat(40000)]
  const started = Date.now()
  for (const s of hostile) {
    mustacheError(s)
    contentError({ html: s, css: s })
  }
  t.true(Date.now() - started < 1000, `took ${Date.now() - started}ms`)
})

async function load ({ publisher = live(), cag = live(), post } = {}) {
  const calls = []
  const mod = await esmock('../tools/templateTools.js', {}, {
    '../services/workApi.js': {
      workApiRequest: async (_s, method, path, opts) => {
        calls.push({ method, path, opts })
        if (method === 'POST') {
          if (post) return post(opts)
          return { success: true, data: { ...opts.body, id: 'n3wtpl', version: 1, dateCreated: 'now' } }
        }
        const r = path.startsWith('/api/publishers/') ? publisher : cag
        if (r instanceof Error) throw r
        return r
      }
    },
    '../services/sessionManager.js': {
      resolveLincxSession: async () => ({ auth_token: 'jwt', email: 'a@b.c' }),
      validateSession: async (a) => ({ valid: true, session: a })
    }
  })
  const tools = {}
  const schemas = {}
  mod.registerTemplateWriteTools({ registerTool: (name, def, h) => { tools[name] = h; schemas[name] = def.inputSchema } })
  const posts = () => calls.filter(c => c.method === 'POST')
  return { tool: tools.create_template, schema: schemas.create_template, calls, posts }
}

const args = (over = {}) => ({
  network_id: NET,
  publisherId: 'pub001',
  creativeAssetGroupId: 'cag001',
  name: 'Listicle',
  html: REAL_HTML,
  ...over
})

const run = async (env, over) => (await env.tool(args(over), {})).content[0].text

test('the schema rejects malformed input before the handler runs', async t => {
  const { schema } = await load()
  const bad = {
    'path-injection id': { publisherId: '../zones/abcdef' },
    'uppercase id': { creativeAssetGroupId: 'CAG001' },
    'blank name': { name: '   ' },
    'whitespace html': { html: ' \n\t ' },
    'newline in name': { name: 'a\nb' },
    'notes (out of scope in v1)': { notes: { general: 'x' } },
    'readOnly field': { version: 3 }
  }
  for (const [label, over] of Object.entries(bad)) {
    t.false(schema.safeParse(args(over)).success, label)
  }
  t.is(schema.parse(args({ name: '  Listicle  ' })).name, 'Listicle', 'name is sent trimmed')
})

test('unsound content is refused before any POST', async t => {
  const env = await load()
  for (const over of [{ html: '```html\n<a/>\n```' }, { html: '<a/><!-- same as before -->' }, { css: '.a{' }]) {
    t.regex(await run(env, over), /^Error: /)
  }
  t.is(env.posts().length, 0)
})

test('happy path sends exactly the template fields and does not echo content', async t => {
  const env = await load()
  const out = await run(env, { css: '.a{}', tieringEnabled: true })
  const [post] = env.posts()
  t.is(post.path, '/api/templates')
  t.deepEqual(post.opts.body, {
    networkId: NET, publisherId: 'pub001', creativeAssetGroupId: 'cag001', name: 'Listicle', html: REAL_HTML, css: '.a{}', tieringEnabled: true
  })
  t.true(out.startsWith('Created template n3wtpl (version 1).'))
  const json = JSON.parse(out.split('\n\n')[1])
  t.deepEqual(json, { id: 'n3wtpl', name: 'Listicle', networkId: NET, publisherId: 'pub001', creativeAssetGroupId: 'cag001', version: 1 })
  t.false(out.includes('lincx-root'), 'html must not be echoed back')
})

test('optional fields are omitted, not sent as undefined/null', async t => {
  const env = await load()
  await run(env)
  t.deepEqual(Object.keys(env.posts()[0].opts.body).sort(), ['creativeAssetGroupId', 'html', 'name', 'networkId', 'publisherId'])
})

const refusals = {
  'oversize content': [{}, { html: '{{#ads}}' + 'x'.repeat(80_000) + '{{/ads}}' }, /limit is 80000/],
  'html copied from a truncated read': [{}, { html: '[elided: 16772 chars]' }, /html contains an "\[elided: …\]" marker/],
  'css copied from a truncated read': [{}, { css: '[elided: 8400 chars]' }, /css contains an "\[elided: …\]" marker/],
  'unbalanced mustache': [{}, { html: '{{#ads}}<div/>' }, /mustache is invalid — \{\{#ads\}\} is never closed/],
  'publisher in another network': [{ publisher: live({ networkId: 'other1' }) }, {}, /publisher pub001 belongs to network other1/],
  'publisher archived': [{ publisher: live({ archived: true }) }, {}, /publisher pub001 is archived/],
  'CAG in another network': [{ cag: live({ networkId: 'other1' }) }, {}, /creative asset group cag001 belongs to network other1/],
  'CAG archived': [{ cag: live({ archived: true }) }, {}, /creative asset group cag001 is archived/],
  'CAG missing': [{ cag: Object.assign(new Error('HTTP 404'), { status: 404 }) }, {}, /creative asset group cag001 not found/]
}

for (const [label, [mocks, over, expected]] of Object.entries(refusals)) {
  test(`refuses without POSTing: ${label}`, async t => {
    const env = await load(mocks)
    t.regex(await run(env, over), expected)
    t.is(env.posts().length, 0)
  })
}

test('upstream 422 reaches the caller verbatim', async t => {
  const env = await load({
    post: () => { throw Object.assign(new Error('HTTP 422'), { status: 422, data: { error: 'Unprocessable Entity', details: 'data.name should match format "name"' } }) }
  })
  t.regex(await run(env), /data\.name should match format "name"/)
})

test('403 reads as a permission gap, timeout as "may exist"', async t => {
  const forbidden = await load({ post: () => { throw Object.assign(new Error('HTTP 403'), { status: 403 }) } })
  t.regex(await run(forbidden), /can't create templates under publisher pub001/)

  const slow = await load({ post: () => { throw Object.assign(new Error('Request timed out'), { code: 'TIMEOUT' }) } })
  t.regex(await run(slow), /MAY have been created.*list_templates/)

  // upstream writes Redis before GCS: a 5xx can leave the template behind
  const boom = await load({ post: () => { throw Object.assign(new Error('HTTP 502'), { status: 502 }) } })
  t.regex(await run(boom), /failed \(502\) — the template MAY have been created.*list_templates/)
})

test('ordinary comments pass; only a whole-body placeholder is refused', t => {
  t.is(contentError({ css: '.a{flex:1} /* fill remaining space */' }), null)
  t.is(contentError({ css: '.t{text-overflow:ellipsis} /* truncated titles */' }), null)
  t.is(contentError({ html: '<div/><!-- omitted when no ads -->' }), null)
  for (const body of ['...', '…', ' rest unchanged ', 'rest of the css', 'remaining code', 'unchanged', 'same as before', 'omitted', 'truncated...']) {
    t.regex(contentError({ html: `<div/><!--${body}-->` }), /placeholder/, body)
  }
})

test('mustacheError accepts a {{! comment }} containing a brace', t => {
  t.is(mustacheError('{{! a } b }}<div>{{title}}</div>'), null)
  t.regex(mustacheError('{{! never closed'), /never closed with \}\}/)
})

// ── registration ──────────────────────────────────────────────────────────────

async function listToolNames () {
  const { start } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      resolveLincxSessionFromBearer: async () => ({ auth_token: 't', email: 'a@b.c', user_id: 'a@b.c' }),
      resolveLincxSession: async () => ({ auth_token: 't', email: 'a@b.c', user_id: 'a@b.c' }),
      resolveUserBucket: (auth) => auth?.user_id ?? 'unknown'
    }
  })
  const { server, port } = await start({ port: 0 })
  const client = new Client({ name: 'c', version: '1.0.0' })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer t' } }
    }))
    return (await client.listTools()).tools.map(x => x.name)
  } finally {
    await client.close()
    await new Promise(resolve => server.close(resolve))
  }
}

test.serial('write tools are registered in tools/list', async t => {
  const names = await listToolNames()
  for (const name of ['create_template', 'update_template_content']) t.true(names.includes(name), name)
})
