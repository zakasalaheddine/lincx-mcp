import test from 'ava'
import { fitEntityToText } from '../services/workApi.js'

const LIMIT = 25_000
const huge = (n) => 'x'.repeat(n)

{ // fitEntityToText
  test('fitEntityToText > returns small entities unchanged and parseable', t => {
    const e = { id: 'c1', name: 'Camp', status: 'active' }
    const text = fitEntityToText(e)
    t.deepEqual(JSON.parse(text), e)
  })

  test('fitEntityToText > elides the largest string field (html) and keeps valid JSON + metadata', t => {
    const tpl = { id: 'tpl1', name: 'Hero', html: huge(40_000), css: huge(2_000) }
    const text = fitEntityToText(tpl)

    t.true(text.length <= LIMIT)
    const parsed = JSON.parse(text) // must not throw
    t.is(parsed.id, 'tpl1')
    t.is(parsed.name, 'Hero')
    t.regex(parsed.html, /^\[elided: 40000 chars\]$/)
    t.true(parsed._truncated.elided.includes('html'))
    // css was small enough to survive once html was elided.
    t.is(parsed.css, huge(2_000))
  })

  /**
   * Field-found 2026-08-04: get_ad_group("ducqqp") returned NO usable data — 232KB
   * of params.zoneId, an array of 20k SHORT strings. No single string leaf was big
   * enough to shed, so the string-only pass could not shrink it and the caller fell
   * through to a bare _truncated note. The readable fields must survive.
   */
  test('fitEntityToText > elides a huge array of small strings and keeps the rest of the entity', t => {
    const ag = {
      id: 'ducqqp',
      name: 'EasyKnock - click_to_post_direct [Exchange]',
      archived: true,
      creativeAssetGroupId: '0bckt2',
      params: { zoneId: Array.from({ length: 20_000 }, (_, i) => `zone${i}`) },
      exceptParams: {}
    }
    const text = fitEntityToText(ag)

    t.true(text.length <= LIMIT)
    const parsed = JSON.parse(text)
    // The fields the caller actually needed are intact.
    t.is(parsed.id, 'ducqqp')
    t.is(parsed.name, 'EasyKnock - click_to_post_direct [Exchange]')
    t.is(parsed.creativeAssetGroupId, '0bckt2')
    t.deepEqual(parsed.exceptParams, {})
    // The runaway array is shed as a unit, with its size still visible.
    t.regex(parsed.params.zoneId, /^\[elided: 20000 items, \d+ chars\]$/)
    t.true(parsed._truncated.elided.includes('params.zoneId'))
  })

  test('fitEntityToText > tracks nested paths for the include:[\'parents\'] shape', t => {
    const wrapped = { entity: { id: 't1', html: huge(40_000) }, parents: [{ id: 'net1', name: 'N' }] }
    const text = fitEntityToText(wrapped)

    const parsed = JSON.parse(text)
    t.is(parsed.entity.id, 't1')
    t.regex(parsed.entity.html, /^\[elided/)
    t.true(parsed._truncated.elided.includes('entity.html'))
    t.is(parsed.parents[0].id, 'net1')
  })

  // The contract: parseable JSON for ANY input, oversized or not.
  test('fitEntityToText > never produces unparseable JSON across object / array / primitive / null', t => {
    const inputs = [
      { id: 'a', blob: huge(60_000) },
      [{ id: '1', body: huge(40_000) }, { id: '2', body: huge(40_000) }],
      huge(40_000),
      42,
      null,
      { nested: { deep: { s: huge(50_000) } } }
    ]
    for (const input of inputs) {
      const text = fitEntityToText(input)
      t.notThrows(() => JSON.parse(text))
      t.true(text.length <= LIMIT)
    }
  })
}
