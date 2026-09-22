import test from 'ava'
import { campaignInWindow } from '../tools/zoneInventoryTools.js'

process.env.TZ = 'America/Denver'

const campaign = { enabled: true, dateEnd: '2026-11-01' }

test('campaign window off UTC > the host really is off UTC, so this file cannot pass vacuously', t => {
  t.not(new Date('2026-11-01').getTimezoneOffset(), 0)
})

test('campaign window off UTC > dateEnd closes at 00:00 UTC the next day across the DST change', t => {
  t.false(campaignInWindow(campaign, Date.parse('2026-11-02T00:30:00Z')))
  t.false(campaignInWindow(campaign, Date.parse('2026-11-02T00:00:00Z')))
})

test('campaign window off UTC > the last second of dateEnd in UTC is still inside', t => {
  t.true(campaignInWindow(campaign, Date.parse('2026-11-01T23:59:59Z')))
})
