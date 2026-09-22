import test from 'ava'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { installToolGuards } from '../middleware/toolGuard.js'
import { RESPONSE_SIZE_LIMIT } from '../constants.js'

// The guard logs one JSON metrics line per call to stderr — silence it in tests.
// ava runs tests within a file concurrently, so console.error is shared state:
// every test here is test.serial.
const realConsoleError = console.error
test.beforeEach(() => { console.error = () => {} })
test.afterEach(() => { console.error = realConsoleError })

function guardedTool (result) {
  const server = new McpServer({ name: 't', version: '0.0.0' })
  server.registerTool(
    'x',
    { description: 'test', inputSchema: z.object({}).strict() },
    async () => result
  )
  installToolGuards(server)
  return (server)._registeredTools.x
}

// installToolGuards (T2-4 response-size guard)
test.serial('installToolGuards (T2-4 response-size guard) > passes a normal-sized response through untouched', async t => {
  const tool = guardedTool({ content: [{ type: 'text', text: 'small' }] })
  const r = await tool.handler({}, { sessionId: 's' })
  t.is(r.isError, undefined)
  t.is(r.content[0].text, 'small')
})

test.serial('installToolGuards (T2-4 response-size guard) > replaces an oversized response with a structured response_too_large error', async t => {
  const big = 'x'.repeat(RESPONSE_SIZE_LIMIT + 100)
  const tool = guardedTool({ content: [{ type: 'text', text: big }] })
  const r = await tool.handler({}, { sessionId: 's' })

  t.is(r.isError, true)
  const body = JSON.parse(r.content[0].text)
  t.is(body.error, 'response_too_large')
  t.is(body.limit, RESPONSE_SIZE_LIMIT)
  t.true(body.size > RESPONSE_SIZE_LIMIT)
  t.regex(body.hint, /pagination|field|filter/i)
})

test.serial('installToolGuards (T2-4 response-size guard) > propagates handler errors (and does not swallow them as oversized)', async t => {
  const server = new McpServer({ name: 't', version: '0.0.0' })
  server.registerTool(
    'boom',
    { description: 'test', inputSchema: z.object({}).strict() },
    async () => { throw new Error('kaboom') }
  )
  installToolGuards(server)
  const tool = (server)._registeredTools.boom
  await t.throwsAsync(tool.handler({}, { sessionId: 's' }), { message: 'kaboom' })
})

// A handler can fail without throwing and without isError — it returns a plain
// "Error: ..." text body (every tool in this repo does). The metrics line must
// still say 'error', or the stderr log reports those calls as successes.
test.serial('installToolGuards status > logs a returned Error: result as status error', async t => {
  const lines = []
  console.error = (line) => lines.push(line)

  const server = new McpServer({ name: 't', version: '0.0.0' })
  server.registerTool('err_tool', { description: 't', inputSchema: z.object({}).strict() },
    async () => ({ content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }))
  server.registerTool('ok_tool', { description: 't', inputSchema: z.object({}).strict() },
    async () => ({ content: [{ type: 'text', text: 'fine' }] }))
  installToolGuards(server)

  await (server)._registeredTools.err_tool.handler({}, {})
  await (server)._registeredTools.ok_tool.handler({}, {})

  const byTool = Object.fromEntries(
    lines.map((l) => JSON.parse(l)).map((r) => [r.tool, r.status])
  )
  t.is(byTool.err_tool, 'error')
  t.is(byTool.ok_tool, 'ok')
})

// An outputSchema'd tool that returns a message instead of a payload (every error
// path in report_query) tripped the SDK's validateToolOutput, whose -32602 REPLACED
// the message — a misconfigured report read as a broken connector. `isError: true`
// is the SDK's own opt-out; the guard sets it. Asserted against the real
// validateToolOutput, not a re-implementation of its rule.
function schemaTool (result, { guard = true } = {}) {
  const server = new McpServer({ name: 't', version: '0.0.0' })
  server.registerTool(
    'x',
    { description: 'test', inputSchema: z.object({}).strict(), outputSchema: z.object({ ok: z.boolean() }) },
    async () => result
  )
  if (guard) installToolGuards(server)
  return { server, tool: (server)._registeredTools.x }
}

test.serial('installToolGuards (outputSchema error path) > marks a payload-less result isError so the SDK returns the message, not -32602', async t => {
  const { server, tool } = schemaTool({ content: [{ type: 'text', text: 'Error: dimension set is missing [hour].' }] })
  const r = await tool.handler({}, { sessionId: 's' })

  t.is(r.isError, true)
  t.is(r.content[0].text, 'Error: dimension set is missing [hour].')
  await t.notThrowsAsync(server.validateToolOutput(tool, r, 'x'))
})

test.serial('installToolGuards (outputSchema error path) > unguarded, the same result is what the SDK rejects', async t => {
  const { server, tool } = schemaTool({ content: [{ type: 'text', text: 'Error: nope' }] }, { guard: false })
  const r = await tool.handler({}, { sessionId: 's' })
  await t.throwsAsync(server.validateToolOutput(tool, r, 'x'), { message: /no structured content was provided/ })
})

test.serial('installToolGuards (outputSchema error path) > leaves a successful structured result untouched', async t => {
  const { server, tool } = schemaTool({ content: [{ type: 'text', text: '{"ok":true}' }], structuredContent: { ok: true } })
  const r = await tool.handler({}, { sessionId: 's' })

  t.is(r.isError, undefined)
  await t.notThrowsAsync(server.validateToolOutput(tool, r, 'x'))
})
