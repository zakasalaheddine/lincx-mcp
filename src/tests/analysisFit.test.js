import test from 'ava'
import { fitAnalysis } from '../tools/analysisTools.js'

const LIMIT = 30_000

/** The wire format is `header\n\ncompact JSON` — parse what the model parses. */
function parse (t, result) {
  const text = result.content[0].text
  const blank = text.indexOf('\n\n')
  t.true(blank > 0)
  return JSON.parse(text.slice(blank + 2))
}

const creatives = (n) =>
  Array.from({ length: n }, (_, i) => ({
    adGroupId: `ag${i}`,
    adId: `ad${i}`,
    creativeId: `cr${i}`,
    impressions: 1000 + i,
    clicks: 10,
    revenue: 5.5,
    ctr: 1.0,
    cpm: 5.5,
    tierScore: 0.42,
    revenueShare: 0.01,
    isStable: true,
    assignedTier: 'TIER_1',
    assignedRank: i
  }))

const rankRows = (n) =>
  Array.from({ length: n }, (_, i) => ({
    adGroupId: `ag${i % 20}`,
    adId: `ad${i % 20}`,
    creativeId: `cr${i % 20}`,
    rank: String(i % 8),
    impressions: 500,
    clicks: 5,
    revenue: 2.5,
    ctr: 1.0,
    cpm: 5.0,
    daysAtRank: 7
  }))

const succeeded = (opts = {}) => ({
  _id: 'cl123',
  status: 'succeeded',
  analysisType: 'offerTiering',
  networkId: 'svce6t',
  request: { zoneId: 'abc123', dateStart: '2026-06-01', dateEnd: '2026-06-30', timezone: 'UTC', noLLM: true },
  input: {
    summary: { rowCount: 4000, contextDays: 30, noLLM: true },
    zoneMetrics: Array.from({ length: 30 }, (_, i) => ({ date: `2026-06-${i + 1}`, rpzl: 1.2 })),
    dataQuality: { lowVolumeRows: 10, totalRows: 4000 },
    tieringContext: {
      datasetConfidence: 'HIGH',
      creatives: creatives(opts.creatives ?? 5),
      localTiers: creatives(opts.localTiers ?? 5).map((c) => ({ ...c, localTier: 'Neutral' })),
      nonMonetizingCreatives: creatives(3),
      defaultTierCreatives: creatives(3),
      rankDistribution: rankRows(opts.ranks ?? 5),
      riskFlags: { rpzlRisk: 'NONE' }
    }
  },
  output: {
    json: { tier_grouping: { recommended_tier_count: 3 }, tier_tables: { TIER_1: [{ creativeId: 'cr0' }] } },
    rawResponse: 'x'.repeat(20_000)
  },
  execution: { provider: 'deterministic', usage: { totalTokens: 0 } }
})

// fitAnalysis
test('fitAnalysis > keeps a queued job intact and tells the caller to keep polling', t => {
  const doc = {
    _id: 'cl1',
    status: 'queued',
    analysisType: 'offerTiering',
    networkId: 'svce6t',
    request: { zoneId: 'abc123', dateStart: '2026-06-01', dateEnd: '2026-06-30' }
  }
  const parsed = parse(t, fitAnalysis(doc, LIMIT))

  t.is(parsed.status, 'queued')
  t.is(parsed._id, 'cl1')
  t.regex(parsed.note, /Poll get_analysis/)
  t.is(parsed.omitted, undefined)
})

test('fitAnalysis > flags a running job the same way', t => {
  const parsed = parse(t, fitAnalysis({ _id: 'cl2', status: 'running' }, LIMIT))
  t.regex(parsed.note, /Poll get_analysis/)
})

test('fitAnalysis > always drops rawResponse and the rendered prompt, whatever the size', t => {
  const doc = succeeded();
  (doc.input).prompt = { rendered: 'you are the lincx analyst...' }
  const parsed = parse(t, fitAnalysis(doc, LIMIT))

  t.is(parsed.output.rawResponse, undefined)
  t.is(parsed.input.prompt, undefined)
  t.is(parsed.output.json.tier_grouping.recommended_tier_count, 3)
  t.is(parsed.input.tieringContext.creatives.length, 5)
})

test('fitAnalysis > sheds rankDistribution first and records what it dropped', t => {
  const doc = succeeded({ creatives: 40, ranks: 400 })
  const parsed = parse(t, fitAnalysis(doc, 12_000))

  t.true(parsed.omitted.includes('input.tieringContext.rankDistribution'))
  t.is(parsed.input.tieringContext.rankDistribution, undefined)
  // The scoring detail and the verdict both survive the first shed.
  t.is(parsed.input.tieringContext.creatives.length, 40)
  t.is(parsed.output.json.tier_tables.TIER_1.length, 1)
})

test('fitAnalysis > sheds localTiers only after the diagnostic lists', t => {
  const doc = succeeded({ creatives: 60, ranks: 600, localTiers: 60 })
  const parsed = parse(t, fitAnalysis(doc, 6_000))

  const droppedBeforeLocal = ['input.tieringContext.nonMonetizingCreatives', 'input.tieringContext.defaultTierCreatives']
  if (parsed.omitted?.includes('input.tieringContext.localTiers')) {
    for (const path of droppedBeforeLocal) t.true(parsed.omitted.includes(path))
  }
  t.not(parsed.output.json, undefined)
})

test('fitAnalysis > falls back to the verdict plus a complete:false flag rather than a silent partial', t => {
  const doc = succeeded({ creatives: 500, ranks: 2000, localTiers: 500 })
  const parsed = parse(t, fitAnalysis(doc, 3_000))

  t.is(parsed.complete, false)
  t.not(parsed.output.json, undefined)
  t.is(parsed.request.zoneId, 'abc123')
  t.regex(parsed.note, /omitted/i)
})

test('fitAnalysis > drops output.json too rather than slicing it into unparseable JSON', t => {
  // A wide zone's tier tables can bust the budget on their own — the branch the
  // earlier limit sweep never reached, because its fixture output was tiny.
  const doc = succeeded()
  doc.output.json = {
    tier_grouping: { recommended_tier_count: 3 },
    tier_tables: { TIER_1: creatives(400) }
  }
  const parsed = parse(t, fitAnalysis(doc, 5_000))

  t.is(parsed.complete, false)
  t.is(parsed.output, undefined)
  t.true(parsed.omitted.includes('output'))
  t.is(parsed.request.zoneId, 'abc123')
  t.regex(parsed.note, /shorter date range/)
})

test('fitAnalysis > emits a header line and parseable JSON for every branch', t => {
  for (const limit of [30_000, 12_000, 6_000, 3_000, 1_000]) {
    const result = fitAnalysis(succeeded({ creatives: 200, ranks: 800 }), limit)
    const text = result.content[0].text
    t.regex(text.split('\n')[0], /^analysis cl123 · offerTiering · succeeded zone abc123/)
    t.notThrows(() => parse(t, result))
  }
})

test('fitAnalysis > never mutates the caller\'s document', t => {
  const doc = succeeded()
  fitAnalysis(doc, 1_000)
  t.is(doc.output.rawResponse.length, 20_000)
  t.is(doc.input.tieringContext.rankDistribution.length, 5)
})
