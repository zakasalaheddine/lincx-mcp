# Zone targeting inventory composite — design

> New MCP tool `get_zone_targeting_inventory(zoneId, mode)`. Moves the exhaustive
> "which ad groups are directly targeted to a zone, and is each fully live" audit
> (Workflow #1) entirely server-side, so no ad-group rows are ever paged through the
> LLM. Companion to the `lincx-inventory` plugin, whose `/zone-targeted` command
> becomes a thin presenter of this tool.
>
> Date: 2026-07-20. Reference: network `7jdz0n` (Core Digital), zone `8z7wzb`,
> CAG `0bckt2`, template `ayf1pr`.

## Why this exists (the problem being fixed)

The plugin's first cut did the audit client-side: page all ad groups via
`list_ad_groups`, filter by `params.zoneId`, then roll up. That is architecturally
wrong here and fails in practice:

- **No upstream zone filter.** `GET /api/ad-groups` accepts only
  `networkId`/`advertiserId`/`campaignId` (swagger `getAdGroupsList`). Targeting
  lives in each ad group's `params.zoneId`, so the full set must be examined.
- **The 30k response guard is an LLM-response cap, not an internal one.**
  `list_ad_groups` slims + drops rows to fit `RESPONSE_SIZE_LIMIT`; requesting full
  `params` (needed for `zoneId`) re-inflates rows — one Accredited Debt Relief ad
  group carries a ~25 KB `pretaxincome` array — so a page of ~50 blows the cap.
  Field projection is top-level only (`params.zoneId` is ignored). Result:
  variable truncation, `next_offset`-driven sequential paging, ~23–46 LLM calls,
  and context exhaustion before the scan finishes. A partial scan cannot answer
  an *exhaustive* question.

### The key enabler

`workApi.ts` (`buildListEnvelope`, lines ~218–229) documents that **every real Work
API list endpoint ignores `limit`/`offset` and returns ALL rows in one response** —
the MCP paginates by slicing that full set client-side purely to fit the LLM guard.
Confirmed live (2026-07-20): `/api/ad-groups` `total:1150`, `/api/ads` `total:1331`,
`/api/creatives` `total:1343`, `/api/campaigns` `total:664`. So **one internal
`workApiRequest` per entity returns the whole network set** — no server-side
pagination loop, no size guard on internal calls. The expensive-looking scan is a
single GET the MCP already makes; the only pain was ever in slicing it to the LLM.

This is the same class of problem `report_query` already solves server-side
("rolls them up so the response stays small instead of dumping hundreds of rows")
— the second sanctioned exception to the thin-MCP rule, chosen deliberately.

## Tool contract

`get_zone_targeting_inventory({ zoneId, mode })`

- `zoneId: string` (required).
- `mode: 'all' | 'live' | 'off'` (default `'all'`). Filters the returned `groups`;
  the `summary` counts are always computed over the full targeted set.

Read-only annotations. `networkId` comes from the session (never a param), per
the thin-tool rules. Mirrors `report_query`: returns `structuredContent` plus a
compact text rendering.

### Return (`structuredContent`)

```
{
  zone: { id, name, creativeAssetGroupId, templateId },
  mode: 'all' | 'live' | 'off',
  summary: { targeted, live, off, archived, conflicting },
  groups: [
    { id, name, archived,
      campaign_on, adgroup_on, has_enabled_ad, creative_resolves,
      has_live_viable_ad, fully_live, off_reason: string[] }
  ],
  conflicting: [ { id, name } ],   // zone in BOTH params.zoneId and exceptParams.zoneId
  scan: { adGroupsScanned, adsScanned, creativesScanned, campaignsScanned }
}
```

`groups` is size-capped with a `groupsTruncated` note if a mega-zone overflows
`RESPONSE_SIZE_LIMIT` (reuse the `capGroups` pattern from `reportingTools`). The
text `content` is a one-line header + the compact JSON (the plugin/LLM renders the
markdown table).

## Server-side flow (all in-memory after single full-set GETs)

1. `GET /api/zones/{zoneId}` → `{ name, creativeAssetGroupId, templateId }`. On 404
   return the standard "Resource not found" error and stop.
2. `GET /api/ad-groups` → all rows. **Select** with the pure `selectTargeting`:
   - zone in `params.zoneId` and NOT in `exceptParams.zoneId` → **targeted**.
   - zone in BOTH → **conflicting** (excluded from targeted; surfaced separately).
   - zone only in `exceptParams.zoneId`, or absent → skip.
3. `GET /api/campaigns` → `campaigns = { [id]: { enabled, archived } }`.
4. `GET /api/ads` → bucket by `adGroupId` → `{ [adGroupId]: [{ enabled, archived, creativeId }] }`.
5. `GET /api/creatives` → `creatives = { [id]: { archived } }` (a `creativeId` absent
   from this map does not resolve).
6. Pure `rollupZoneTargeting({ zoneId, zoneCag, targeted, conflicting, campaigns,
   adsByGroup, creatives, mode })` → `{ groups, summary }`.

Steps 1–5 are independent single GETs — issue them with `Promise.all`.

## Rollup semantics (ported from the plugin's tested helper)

A level is **on** only if `enabled === true && archived !== true` (a missing
`archived` key means not archived — Work API omits it when false).

| flag | source |
|---|---|
| `campaign_on` | `campaigns[campaignId]` on |
| `adgroup_on` | ad group on |
| `has_live_viable_ad` | ∃ ad: `ad` on **and** `creatives[ad.creativeId]` resolves **and** is not archived |

- **`has_live_viable_ad` is a per-ad conjunction** — never combine "some enabled ad"
  with "some resolving creative" across different ads. `has_enabled_ad` and
  `creative_resolves` are reported separately as diagnostics only.
- **Creative viability** = the ad's `creativeId` resolves to an existing creative
  that is not archived. Creatives have no `enabled` field but do carry `archived`
  (verified live).
- `fully_live = campaign_on && adgroup_on && has_live_viable_ad`.
- `off_reason` lists failing levels: `campaign`, `archived` (ad group archived) or
  `adgroup` (disabled, not archived), `no_live_viable_ad`.
- **Archived ad groups** are included, flagged, and always `off` (`adgroup_on`
  false forces it) — maximizes "none missing".

`summary`: `targeted` = matched count, `live`/`off` over the full set, `archived` =
archived matched count, `conflicting` = count from step 2.

## Files

MCP repo:
- `src/tools/zoneInventoryTools.ts` — registers `get_zone_targeting_inventory`;
  exports the pure `selectTargeting` + `rollupZoneTargeting` for tests. Thin
  orchestration (session guard → 5 GETs → rollup → envelope), the `report_query`
  shape.
- `src/index.ts` — register the new tool group.
- `test/zoneInventory.test.ts` — vitest unit tests on the pure functions (mirror
  `test`'s existing pure-helper coverage), including the per-ad-conjunction
  discriminator and archived-forces-off.
- `CLAUDE.md` — add the tool to the Implemented Tools list; note it as the second
  sanctioned server-side composite (with `report_query`).

Marketplace repo (companion, separate PR/commit on the existing branch):
- `plugins/lincx-inventory/skills/zone-targeted/SKILL.md` — replace the whole
  scan/fetch/rollup flow with a single `get_zone_targeting_inventory` call + render.
- Delete `scripts/zone-inventory-rollup.mjs` + `tests/zone-inventory-rollup.test.mjs`
  (logic now lives, and is tested, in the MCP). Keep `session-state.mjs` (last-zone
  memory) and the command. Update `check-plugin.mjs` to drop the deleted files.

## Out of scope (built to extend)

The "free radicals" leg (ad groups targeting no zone that still render via the
shared CAG) — a later `mode` or sibling tool. `selectTargeting` + the CAG data
already gathered are the building blocks.

## Cost / safety

Five internal GETs (~one network round-trip each; the largest is `/api/ad-groups`
with full params, a few MB in MCP memory — fine for Node, invisible to the LLM).
The LLM sees only the compact matched result (dozens of groups). No new
dependency, no persistence. `networkId` from session; standard auth/validate
guards; `handleWorkApiError` for upstream failures.
