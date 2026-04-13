# Lincx MCP — Implementation Design

> Date: 2026-04-13
> Status: Approved
> Scope: Full tool surface across 4 milestones. Auth + network tools already shipped — out of scope here.

---

## Approach

Extend the existing codebase incrementally. No restructuring. Every new domain gets its own file in `src/tools/`. Each file exports `registerXxxTools(server, getSessionId)`, registered in `src/index.ts` — the same pattern as `authTools.ts` and `networkTools.ts`.

One shared pattern for all tools:
1. `validateSession(sessionId)` — fail fast if not authenticated
2. `workApiRequest(session, method, path, params)` — network context auto-injected via `?networkId`
3. Return `{ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }`

---

## Milestones

| Milestone | Label | Objective |
|---|---|---|
| M1 | `template-workbench` | Template read + render |
| M2 | `zone-debugger` | Zone entity tree + `zone_load_trace` composite |
| M3 | `reporting` | Dimension sets, event stats, `report_query` |
| M4 | `write-tools` | `update_template_draft` write tool |

---

## M1 — Template Workbench

**Files:** `src/tools/templateTools.ts`, `src/tools/creativeAssetGroupTools.ts`

### Tools

| Tool | Method | Endpoint |
|---|---|---|
| `list_templates` | GET | `/api/templates` |
| `get_template` | GET | `/api/templates/{id}` |
| `get_template_versions` | GET | `/api/templates/{id}/versions` |
| `get_template_version` | GET | `/api/templates/{id}/versions/{version}` |
| `get_template_parents` | GET | `/api/templates/{id}/parents` |
| `list_creative_asset_groups` | GET | `/api/creative-asset-groups` |
| `get_creative_asset_group` | GET | `/api/creative-asset-groups/{id}` |
| `render_template` | composite | — |

### `render_template` design

Templates contain HTML + CSS. Each template has exactly one associated creative asset group. The creative asset group defines the ad data schema (the fields mock ads must conform to).

**Input schema:**
```ts
z.object({
  templateId: z.string(),
  version: z.number().int().optional(),        // omit = latest
  mockAds: z.array(z.record(z.unknown())).optional(), // omit = auto-generated
}).strict()
```

**Execution flow:**
1. Fetch template via `get_template` (or `get_template_version` if `version` given) — extract HTML, CSS, and linked `creativeAssetGroupId`
2. Fetch creative asset group via `get_creative_asset_group` — read its schema
3. If `mockAds` not provided, generate 1–2 placeholder ad objects conforming to the creative asset group schema
4. Inject mock ads into the template HTML using the data envelope shape from `GET /api/ads/ad` (`{ads, template}`)
5. Return raw HTML + CSS + mock data used

**Output shape:**
```json
{
  "templateId": "abc123",
  "version": 4,
  "html": "<div class=\"lincx-ad\">...</div>",
  "css": ".lincx-ad { ... }",
  "creativeAssetGroupId": "cag-xyz",
  "mockAdsUsed": [{ "id": "mock-1", ... }]
}
```

No server-side sandbox, no screenshot, no asset fetching. The engineer reviews the HTML string locally.

> Note: The exact ad data envelope injected into the template must be confirmed against the real `GET /api/ads/ad` response on first integration.

---

## M2 — Zone Debugger

**Files:** `src/tools/zoneTools.ts`, `src/tools/adTools.ts`, `src/tools/adGroupTools.ts`, `src/tools/creativeTools.ts`, `src/tools/campaignTools.ts`, `src/tools/channelTools.ts`, `src/tools/siteTools.ts`, `src/tools/publisherTools.ts`

### Tools

| Tool | Method | Endpoint |
|---|---|---|
| `list_zones` | GET | `/api/zones` |
| `get_zone` | GET | `/api/zones/{id}` |
| `get_zone_parents` | GET | `/api/zones/{id}/parents` |
| `get_zone_report` | GET | `/api/zones/{id}/report` |
| `list_ads` | GET | `/api/ads` |
| `get_ad` | GET | `/api/ads/{id}` |
| `get_ad_parents` | GET | `/api/ads/{id}/parents` |
| `get_zone_ads` | GET | `/api/ads/ad?zoneId=` (ad serving endpoint) |
| `list_ad_groups` | GET | `/api/ad-groups` |
| `get_ad_group` | GET | `/api/ad-groups/{id}` |
| `get_ad_group_parents` | GET | `/api/ad-groups/{id}/parents` |
| `list_creatives` | GET | `/api/creatives` |
| `get_creative` | GET | `/api/creatives/{id}` |
| `get_creative_parents` | GET | `/api/creatives/{id}/parents` |
| `list_campaigns` | GET | `/api/campaigns` |
| `get_campaign` | GET | `/api/campaigns/{id}` |
| `get_campaign_parents` | GET | `/api/campaigns/{id}/parents` |
| `list_channels` | GET | `/api/channels` |
| `get_channel` | GET | `/api/channels/{id}` |
| `get_channel_parents` | GET | `/api/channels/{id}/parents` |
| `list_sites` | GET | `/api/sites` |
| `get_site` | GET | `/api/sites/{id}` |
| `get_site_parents` | GET | `/api/sites/{id}/parents` |
| `list_publishers` | GET | `/api/publishers` |
| `get_publisher` | GET | `/api/publishers/{id}` |
| `zone_load_trace` | composite | — |

### `zone_load_trace` design

**Input:**
```ts
z.object({ zoneId: z.string() }).strict()
```

**Execution flow (parallel where possible):**
```
Round 1 (parallel):
  GET /api/zones/{zoneId}
  GET /api/zones/{zoneId}/parents
  GET /api/ads/ad?zoneId={zoneId}          → { ads, template }
  GET /api/ads/ad/debug?zoneId={zoneId}    → debug matching data

Round 2 (parallel, using Round 1 results):
  GET /api/ads/{id}  for each matched ad
  GET /api/creatives/{id}  for each creative on matched ads

Round 3:
  GET /api/templates/{templateId}  for zone template + ad templates (dedup)
```

**Output:**
```json
{
  "zone": { ... },
  "parents": { ... },
  "matching": {
    "matched": [...],
    "rejected": [...],
    "debug": { ... }
  },
  "ads": [...],
  "creatives": [...],
  "templates": [...],
  "summary": "Zone X is serving 3 ads. 2 ad-groups matched. Template: ..."
}
```

Returns structured data for LLM reasoning + a `summary` string for quick chat render.

---

## M3 — Reporting

**Files:** `src/tools/reportingTools.ts`, `src/tools/advertiserTools.ts`, `src/tools/experienceTools.ts`

### Tools

| Tool | Method | Endpoint |
|---|---|---|
| `list_dimension_sets` | GET | `/api/dimension-sets` |
| `get_dimension_set` | GET | `/api/dimension-sets/{id}` |
| `get_event_stats_keys` | GET | `/api/event-stats` |
| `report_query` | composite | `GET /api/reports/{dimensionSetId}` |
| `zone_report` | GET | `/api/zones/{id}/report` |
| `list_advertisers` | GET | `/api/advertisers` |
| `get_advertiser` | GET | `/api/advertisers/{id}` |
| `list_experiences` | GET | `/api/experiences` |
| `get_experience` | GET | `/api/experiences/{id}` |

### `report_query` design

**Input:**
```ts
z.object({
  dimensionSetId: z.string(),
  startDate: z.string(),   // ISO date
  endDate: z.string(),     // ISO date
  resolution: z.enum(["day", "hour"]).default("day"),
  filters: z.record(z.string()).optional(),  // dimension key→value pairs
}).strict()
```

**Flow:**
1. Optional: call `get_event_stats_keys` to validate filter keys against active network
2. Call `GET /api/reports/{dimensionSetId}` with date range + filters
3. Return raw report data + a brief summary of the time range and row count

---

## M4 — Write Tools

**File:** addition to `src/tools/templateTools.ts`

### Tools

| Tool | Method | Endpoint |
|---|---|---|
| `update_template_draft` | POST | `/api/templates/{id}/patch` |

**Input:**
```ts
z.object({
  templateId: z.string(),
  html: z.string().optional(),
  css: z.string().optional(),
}).strict()
```

Write tool. Description must include an explicit warning requiring the engineer to confirm before Claude calls it. No role system in the current session model — gating is via the tool description and Claude's confirmation behavior.

---

## GitHub Issue Map

### Milestone 1 — Template Workbench (7 issues)

| # | Title |
|---|---|
| 1 | Add `list_templates` and `get_template` tools |
| 2 | Add `get_template_versions` and `get_template_version` tools |
| 3 | Add `get_template_parents` tool |
| 4 | Add `list_creative_asset_groups` and `get_creative_asset_group` tools |
| 5 | Add `render_template` composite tool |
| 6 | Register all M1 tools in `index.ts` and rebuild |
| 7 | Update CLAUDE.md with M1 tool documentation |

### Milestone 2 — Zone Debugger (10 issues)

| # | Title |
|---|---|
| 8 | Add `list_zones`, `get_zone`, `get_zone_parents`, `get_zone_report` tools |
| 9 | Add `list_ads`, `get_ad`, `get_ad_parents`, `get_zone_ads` tools |
| 10 | Add `list_ad_groups`, `get_ad_group`, `get_ad_group_parents` tools |
| 11 | Add `list_creatives`, `get_creative`, `get_creative_parents` tools |
| 12 | Add `list_campaigns`, `get_campaign`, `get_campaign_parents` tools |
| 13 | Add `list_channels`, `get_channel`, `get_channel_parents` tools |
| 14 | Add `list_sites`, `get_site`, `get_site_parents` tools |
| 15 | Add `list_publishers` and `get_publisher` tools |
| 16 | Add `zone_load_trace` composite tool |
| 17 | Register all M2 tools in `index.ts` and rebuild |

### Milestone 3 — Reporting (8 issues)

| # | Title |
|---|---|
| 18 | Add `list_dimension_sets` and `get_dimension_set` tools |
| 19 | Add `get_event_stats_keys` tool |
| 20 | Add `report_query` composite tool |
| 21 | Add `zone_report` tool |
| 22 | Add `list_advertisers` and `get_advertiser` tools |
| 23 | Add `list_experiences` and `get_experience` tools |
| 24 | Register all M3 tools in `index.ts` and rebuild |
| 25 | Update CLAUDE.md with M2 + M3 tool documentation |

### Milestone 4 — Write Tools (1 issue)

| # | Title |
|---|---|
| 26 | Add `update_template_draft` write tool |

---

## Open decisions carried forward

- Exact ad data envelope shape for `render_template` — confirm against real `GET /api/ads/ad` response
- Creative asset group schema format — confirm field definitions from real API response
- `update_template_draft` fields — confirm which fields `POST /api/templates/{id}/patch` accepts
