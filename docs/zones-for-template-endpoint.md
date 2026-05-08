# Decision Record: Zones-for-Template Endpoint

**Date:** 2026-05-08
**Author:** Task 1 research (grep over lincx-core source)
**Status:** DECIDED — no new endpoint required

---

## Decision

There is **no** dedicated `GET /api/templates/:id/zones` route and **no** `templateId` query
parameter on `GET /api/zones` in lincx-core. The correct approach is:

> **`GET /api/zones?networkId=<id>` (client-side filter)**
>
> `workApiRequest` always injects `networkId` from `session.active_network`, so the call is
> simply `GET /api/zones` with no extra parameters. The caller filters the returned array
> in-process: `zones.filter(z => z.templateId === templateId)`.

This is the cheapest path: zero backend changes, works today, and the zone schema already
stores `templateId` as a first-class field.

### Evidence

| File | Line | Observation |
|---|---|---|
| `lincx-core/server/model/zone.js` | 287 | `getList({ publisherId, channelId, siteId, networkId })` — `templateId` is NOT a supported filter |
| `lincx-core/server/routes/zones.js` | 156–196 | OpenAPI spec for `GET /api/zones` lists only `publisherId`, `channelId`, `siteId`, `networkId`, `extended` as query params |
| `lincx-core/server/model/zone.json` | 33–36 | `templateId` is a string property on every zone object |
| `lincx-core/server/model/template.js` | 218 | Template's own archive guard already does the same in-process filter: `zone.templateId === id` |
| `mcp/src/services/workApi.ts` | 26 | `networkId` is always injected server-side; `GET /api/zones` already returns all network zones |
| `mcp/src/tools/zoneTools.ts` | 172 | `get_zone_ads` confirms `templateId` is present on the serving response — binding is server-side |

No route matching `templates/.*zones` or `template_id` filter was found in either
lincx-core or lincx-app (lincx-app has no backend routes; it is a React front-end).

---

## Response Shape

`GET /api/zones?networkId=<id>` returns:

```json
{
  "data": [
    {
      "id": "abc123",
      "name": "My Zone",
      "networkId": "net001",
      "siteId": "site01",
      "publisherId": "pub01",
      "channelId": "ch001",
      "templateId": "tpl001",
      "templateIdDateUpdated": "2025-01-15T10:00:00.000Z",
      "creativeAssetGroupId": "cag001",
      "archived": false,
      ...
    }
  ]
}
```

The caller filters `data` by `templateId`. Zones without a template (`templateId` absent or
`null`) are excluded by the filter naturally.

**Curl probe:** Deferred to Task 8 (manual smoke test) — no `$LINCX_TOKEN` available at
research time.

---

## Ad-Count Strategy

Zone objects returned by `GET /api/zones` do **not** carry an `adCount` field — the zone
schema (`lincx-core/server/model/schemas/zone.json`) has no such property. Counting ads
requires a separate `GET /api/zones/:id/ads` call per zone.

**Strategy (per spec, locked in brainstorming):** highest ad count wins; ties broken by
the order zones come back from `/api/zones`.

Steps inside `get_template_preview_bundle`:

1. `GET /api/zones` (network is implicit via session) → filter to
   `zones.filter(z => z.templateId === templateId)`.
2. For each matching zone, `GET /api/zones/:id/ads` and use `ads.length`.
3. Pick the zone with the largest count. On tie, take the first by API order.
4. Return that zone's ads as `mockAds`. If zero zones or every zone has zero ads,
   fall through to CAG-synthesized ads with a warning.

The N+1 cost is bounded: most templates bind 1–3 zones, so this loop runs a small
constant number of times. This was an explicit trade-off in the design — keeping the
ranking client-side lets us tweak the policy (e.g. switch to "most recent") without a
server redeploy.

---

## Blocking PRs

None. No lincx-core changes are required. The approach is entirely client-side inside the
MCP tool implementation.
