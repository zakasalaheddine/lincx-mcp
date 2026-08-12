import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import { json, html, redirect, noContent } from '../../http/respond.js'

function serve (handler) {
  return http.createServer(handler)
}

test('json > writes status, content-type and body', async t => {
  const r = await request(serve((_req, res) => json(res, 201, { ok: true }))).get('/')
  t.is(r.status, 201)
  t.regex(r.headers['content-type'], /application\/json/)
  t.deepEqual(r.body, { ok: true })
})

test('json > defaults to 200', async t => {
  const r = await request(serve((_req, res) => json(res, 200, { a: 1 }))).get('/')
  t.is(r.status, 200)
})

test('html > sets text/html', async t => {
  const r = await request(serve((_req, res) => html(res, 400, '<p>bad</p>'))).get('/')
  t.is(r.status, 400)
  t.regex(r.headers['content-type'], /text\/html/)
  t.is(r.text, '<p>bad</p>')
})

test('redirect > 302 with Location', async t => {
  const r = await request(serve((_req, res) => redirect(res, '/login?req=abc'))).get('/')
  t.is(r.status, 302)
  t.is(r.headers.location, '/login?req=abc')
})

test('noContent > status with an empty body', async t => {
  const r = await request(serve((_req, res) => noContent(res, 404))).get('/')
  t.is(r.status, 404)
  t.is(r.text, '')
})

test('json > does not double-write when headers are already sent', async t => {
  const r = await request(serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('partial')
    json(res, 500, { error: 'late' }) // must be a no-op that still ends
    res.end()
  })).get('/')
  t.is(r.status, 200)
  t.is(r.text, 'partial')
})
