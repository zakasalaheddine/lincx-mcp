import test from 'ava'
import { buildListEnvelope, listEnvelopeToText } from '../services/workApi.js'

{ // buildListEnvelope
  test('buildListEnvelope > slices the window client-side when upstream returns the full set (no total)', t => {
    // Real Work API behavior: ignores limit/offset, returns every row, no total.
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i), name: `n${i}` }))

    const page1 = buildListEnvelope(items, { limit: 25, offset: 0 })
    t.is(page1.items.length, 25)
    t.is((page1.items[0]).id, '0')
    t.is(page1.total, 100)
    t.is(page1.has_more, true)
    t.is(page1.next_offset, 25)

    const page2 = buildListEnvelope(items, { limit: 25, offset: 25 })
    // The bug: offset was ignored so page2 === page1. It must now differ.
    t.is((page2.items[0]).id, '25')
    t.is(page2.total, 100)
  })

  test('buildListEnvelope > sets has_more false / next_offset null on the last partial page', t => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `n${i}` }))
    const env = buildListEnvelope(items, { limit: 25, offset: 25 })
    t.is(env.items.length, 5)
    t.is(env.has_more, false)
    t.is(env.next_offset, null)
  })

  test('buildListEnvelope > returns an empty page (no more) when offset is past the end', t => {
    const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `n${i}` }))
    const env = buildListEnvelope(items, { limit: 25, offset: 50 })
    t.is(env.items.length, 0)
    t.is(env.total, 10)
    t.is(env.has_more, false)
    t.is(env.next_offset, null)
  })

  test('buildListEnvelope > uses the upstream total when present', t => {
    const env = buildListEnvelope({ items: [{ id: '1', name: 'a' }], total: 99 }, { limit: 25, offset: 0 })
    t.is(env.total, 99)
    t.is(env.has_more, true)
    t.is(env.next_offset, 1)
  })

  test('buildListEnvelope > projects to { id, name } + status by default; [\'*\'] returns full rows minus heavy fields', t => {
    const row = { id: '1', name: 'a', status: 'active', note: 'keep-me', html: '<huge/>' }
    const projected = buildListEnvelope([row], { limit: 25, offset: 0 }).items[0]
    t.deepEqual(projected, { id: '1', name: 'a', status: 'active' })
    t.false('note' in projected)

    const full = buildListEnvelope([row], { limit: 25, offset: 0, fields: ['*'] }).items[0]
    // '*' keeps non-heavy fields like `note` but still drops content blobs like `html`.
    t.deepEqual(full, { id: '1', name: 'a', status: 'active', note: 'keep-me' })
    t.false('html' in full)
  })
}

/**
 * Field-found 2026-08-04: fields:["params.zoneId"] returned NEITHER field and no
 * error — the row came back looking clean with the data silently absent, and the
 * only way to shrink a page (the whole point on a collection holding a 232KB row)
 * was unavailable.
 */
{ // dotted field paths
  const rows = [
    { id: 'a', name: 'A', params: { zoneId: ['z1', 'z2'], other: 1 }, exceptParams: {} },
    { id: 'b', name: 'B', params: {}, exceptParams: { zoneId: ['z9'] } }
  ]

  test('dotted field paths > projects the leaf under its dotted key, not the whole parent object', t => {
    const env = buildListEnvelope(rows, { limit: 25, offset: 0, fields: ['params.zoneId', 'exceptParams.zoneId'] })
    const [a, b] = env.items
    t.deepEqual(a['params.zoneId'], ['z1', 'z2'])
    t.is(a.params, undefined) // the heavy parent is NOT included
    t.is(a['exceptParams.zoneId'], undefined) // absent on this row, fine
    t.deepEqual(b['exceptParams.zoneId'], ['z9'])
  })

  test('dotted field paths > dotted selection is dramatically smaller than pulling the parent', t => {
    const fat = [{ id: 'x', name: 'X', params: { zoneId: ['z1'], junk: Array.from({ length: 5000 }, (_, i) => `j${i}`) } }]
    const dotted = JSON.stringify(buildListEnvelope(fat, { limit: 25, offset: 0, fields: ['params.zoneId'] })).length
    const parent = JSON.stringify(buildListEnvelope(fat, { limit: 25, offset: 0, fields: ['params'] })).length
    t.true(dotted < parent / 10)
  })

  test('dotted field paths > flags a requested field that matched no row instead of failing silently', t => {
    const env = buildListEnvelope(rows, { limit: 25, offset: 0, fields: ['params.zoneId', 'nope', 'params.missing'] })
    t.deepEqual(env.unknown_fields, ['nope', 'params.missing'])
  })

  test('dotted field paths > omits unknown_fields entirely when every requested field matched', t => {
    const env = buildListEnvelope(rows, { limit: 25, offset: 0, fields: ['params.zoneId'] })
    t.is(env.unknown_fields, undefined)
  })

  test('dotted field paths > an empty collection reports nothing unknown — no rows is no evidence', t => {
    // Field-found on network 6s31vy (0 ads): every requested field flagged, including
    // adGroupId, which reads as "your paths are wrong" when the truth is "no rows".
    const env = buildListEnvelope([], { limit: 100, offset: 0, fields: ['params.zoneId', 'adGroupId'] })
    t.is(env.total, 0)
    t.is(env.unknown_fields, undefined)
  })

  test('dotted field paths > judges paths against the whole collection, not the page — a sparse field is not \'unknown\'', t => {
    // exceptParams.zoneId exists on exactly one row, far outside the first page.
    const sparse = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, params: { zoneId: ['z'] } })),
      { id: 'rare', params: { zoneId: ['z'] }, exceptParams: { zoneId: ['z9'] } }
    ]
    const page1 = buildListEnvelope(sparse, { limit: 100, offset: 0, fields: ['params.zoneId', 'exceptParams.zoneId'] })
    // No row on page 1 carries it, but it is real — flagging it would abort a sweep.
    t.is(page1.unknown_fields, undefined)

    const bogus = buildListEnvelope(sparse, { limit: 100, offset: 0, fields: ['exceptParams.nope'] })
    t.deepEqual(bogus.unknown_fields, ['exceptParams.nope']) // genuinely absent everywhere
  })
}

{ // listEnvelopeToText
  test('listEnvelopeToText > returns compact (non-indented) JSON when under the limit', t => {
    const env = buildListEnvelope([{ id: '1', name: 'a' }], { limit: 25, offset: 0 })
    const text = listEnvelopeToText(env)
    t.false(text.includes('\n'))
    t.is(JSON.parse(text).items.length, 1)
  })

  test('listEnvelopeToText > drops items instead of slicing — output stays valid JSON when oversized', t => {
    // Each item ~1KB of name → 200 items blows past the 25k char limit.
    const items = Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: 'x'.repeat(1000) }))
    const env = buildListEnvelope(items, { limit: 200, offset: 0 })
    const text = listEnvelopeToText(env)

    // The whole point of the fix: never emit unparseable JSON.
    const parsed = JSON.parse(text)
    t.true(text.length <= 25_000)
    t.true(parsed.items.length < 200)
    t.is(parsed.has_more, true)
    // next_offset points at the first dropped item so the caller can continue.
    t.is(parsed.next_offset, parsed.items.length)
    t.is(parsed.truncated.fetched, 200)
  })

  /**
   * Field-found 2026-08-04: ad group `ducqqp` serializes to 232KB on its own, so no
   * full item fit, kept.length hit 0, and next_offset came back EQUAL to the requested
   * offset. "Page until next_offset is absent" then loops forever on that row and the
   * rest of the collection is unreachable. The walk must always advance.
   */
  { // a single row bigger than the whole budget
    const poison = (id) => ({ id, name: 'n', params: { zoneId: Array.from({ length: 20_000 }, (_, i) => `z${i}`) } })

    test('listEnvelopeToText > a single row bigger than the whole budget > advances next_offset past the poison row instead of stalling', t => {
      // Exactly the field shape: the poison row sits AT the requested offset.
      const items = [{ id: 'first', name: 'a' }, poison('ducqqp'), { id: 'next', name: 'b' }]
      const env = buildListEnvelope(items, { limit: 100, offset: 1, fields: ['params'] })
      const parsed = JSON.parse(listEnvelopeToText(env))
      t.is(parsed.next_offset, 2) // was 1 — the stall
      t.true(parsed.next_offset > env.offset)
    })

    test('listEnvelopeToText > a single row bigger than the whole budget > names the skipped row rather than swallowing it, and stays under the limit', t => {
      const env = buildListEnvelope([poison('ducqqp')], { limit: 100, offset: 0, fields: ['params'] })
      const text = listEnvelopeToText(env)
      const parsed = JSON.parse(text)
      t.true(text.length <= 25_000)
      t.is(parsed.items.length, 1)
      t.is(parsed.items[0].id, 'ducqqp')
      t.not(parsed.items[0]._omitted, undefined)
      t.is(parsed.truncated.returned, 0) // no FULL row was returned
      t.is(parsed.truncated.skipped_oversized, 'ducqqp')
    })

    test('listEnvelopeToText > a single row bigger than the whole budget > a full walk terminates even when the collection is all poison rows', t => {
      const items = [poison('a'), poison('b'), poison('c')]
      const seen = []
      let offset = 0
      let guard = 0
      while (offset !== null) {
        if (++guard > 10) throw new Error('walk did not terminate')
        const parsed = JSON.parse(listEnvelopeToText(buildListEnvelope(items, { limit: 100, offset, fields: ['params'] })))
        for (const it of parsed.items) seen.push(it.id)
        offset = parsed.has_more ? parsed.next_offset : null
      }
      t.deepEqual(seen, ['a', 'b', 'c']) // every id reachable, none repeated
    })
  }
}
