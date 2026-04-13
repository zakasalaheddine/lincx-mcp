# Zone Debugger (M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 25 MCP tools covering zones, ads, ad-groups, creatives, campaigns, channels, sites, and publishers — plus the `zone_load_trace` composite that fans out across them all.

**Architecture:** Same pattern as M1. One file per domain in `src/tools/`. All registered in `src/index.ts`. The composite `zone_load_trace` lives in `zoneTools.ts` and uses `Promise.all` for parallel API calls.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, native `fetch` via `workApiRequest`

**Working directory:** `/Users/salaheddinezaka/Documents/work/mcp/.worktrees/m2-zone-debugger`

**Spec:** `docs/superpowers/specs/2026-04-13-lincx-mcp-design.md`

---

## File Map

| Action | File | Tools |
|---|---|---|
| Create | `src/tools/zoneTools.ts` | list_zones, get_zone, get_zone_parents, get_zone_report, zone_load_trace |
| Create | `src/tools/adTools.ts` | list_ads, get_ad, get_ad_parents, get_zone_ads |
| Create | `src/tools/adGroupTools.ts` | list_ad_groups, get_ad_group, get_ad_group_parents |
| Create | `src/tools/creativeTools.ts` | list_creatives, get_creative, get_creative_parents |
| Create | `src/tools/campaignTools.ts` | list_campaigns, get_campaign, get_campaign_parents |
| Create | `src/tools/channelTools.ts` | list_channels, get_channel, get_channel_parents |
| Create | `src/tools/siteTools.ts` | list_sites, get_site, get_site_parents |
| Create | `src/tools/publisherTools.ts` | list_publishers, get_publisher |
| Modify | `src/index.ts` | Register all 8 new tool files |

---

## Standard Tool Pattern

Every tool follows this shape exactly — same as M1. Do not deviate:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerXxxTools(server: McpServer, getSessionId: () => string | null): void {
  server.registerTool("tool_name", {
    title: "Human Title",
    description: `Description.`,
    inputSchema: z.object({ /* never networkId */ }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ /* params */ }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/endpoint", { params: { /* ... */ } });
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

**Rules:**
- Never `console.log` (stdout = wire protocol)
- Never `networkId` in any inputSchema
- All imports use `.js` extension
- `truncateIfNeeded` on all list responses and any single-item that may have large payloads
- `npm run build` must pass after every task

---

## Task 1: Zone tools (except zone_load_trace)

**File:** Create `src/tools/zoneTools.ts`

Export `registerZoneTools(server, getSessionId)` with 4 tools:

### `list_zones`
- Endpoint: `GET /api/zones`
- Input: `{ limit: number int 1–100 default 20, offset: number int min 0 default 0 }`
- Use `truncateIfNeeded`

### `get_zone`
- Endpoint: `GET /api/zones/{id}`
- Input: `{ id: string }`
- Use `truncateIfNeeded`

### `get_zone_parents`
- Endpoint: `GET /api/zones/{id}/parents`
- Input: `{ id: string }`
- Description: "Returns the full parent chain: site → channel → publisher → network"

### `get_zone_report`
- Endpoint: `GET /api/zones/{id}/report`
- Input:
  ```ts
  z.object({
    id: z.string().describe("Zone ID"),
    resolution: z.enum(["day", "hour"]).default("day"),
    startDate: z.string().describe("ISO date e.g. 2026-01-01"),
    endDate: z.string().describe("ISO date e.g. 2026-01-31"),
  }).strict()
  ```
- Pass `resolution`, `startDate`, `endDate` as params to `workApiRequest`
- Use `truncateIfNeeded`

**After creating:** Register in `src/index.ts`, build, commit:
```bash
git add src/tools/zoneTools.ts src/index.ts
git commit -m "feat: add list_zones, get_zone, get_zone_parents, get_zone_report tools"
```

---

## Task 2: Ad tools

**File:** Create `src/tools/adTools.ts`

Export `registerAdTools(server, getSessionId)` with 4 tools:

### `list_ads`
- Endpoint: `GET /api/ads`
- Input: `{ limit: number int 1–100 default 20, offset: number int min 0 default 0 }`
- Use `truncateIfNeeded`

### `get_ad`
- Endpoint: `GET /api/ads/{id}`
- Input: `{ id: string }`
- Use `truncateIfNeeded`

### `get_ad_parents`
- Endpoint: `GET /api/ads/{id}/parents`
- Input: `{ id: string }`

### `get_zone_ads`
- Endpoint: `GET /api/ads/ad` — the **ad-serving** endpoint (not CRUD)
- Input:
  ```ts
  z.object({
    zoneId: z.string().describe("Zone ID to fetch serving ads for"),
    adFeedCount: z.number().int().optional(),
    geoState: z.string().optional(),
    geoCity: z.string().optional(),
    geoIP: z.string().optional(),
    geoPostal: z.string().optional(),
    geoCountry: z.string().optional(),
    scoreKey: z.string().optional(),
  }).strict()
  ```
- Description: "Calls the ad-serving endpoint for a zone. Returns `{ ads, template }` — the ads that would be shown and the template they render into."
- Use `truncateIfNeeded`
- Pass all provided params to `workApiRequest`

**Register, build, commit:**
```bash
git add src/tools/adTools.ts src/index.ts
git commit -m "feat: add list_ads, get_ad, get_ad_parents, get_zone_ads tools"
```

---

## Task 3: Ad group, creative, campaign tools

**Files:** Create `src/tools/adGroupTools.ts`, `src/tools/creativeTools.ts`, `src/tools/campaignTools.ts`

### adGroupTools.ts — export `registerAdGroupTools`
- `list_ad_groups` — `GET /api/ad-groups`, limit/offset
- `get_ad_group` — `GET /api/ad-groups/{id}`
- `get_ad_group_parents` — `GET /api/ad-groups/{id}/parents`

### creativeTools.ts — export `registerCreativeTools`
- `list_creatives` — `GET /api/creatives`, limit/offset
- `get_creative` — `GET /api/creatives/{id}`
- `get_creative_parents` — `GET /api/creatives/{id}/parents`

### campaignTools.ts — export `registerCampaignTools`
- `list_campaigns` — `GET /api/campaigns`, limit/offset
- `get_campaign` — `GET /api/campaigns/{id}`
- `get_campaign_parents` — `GET /api/campaigns/{id}/parents`

All 3 files follow the standard pattern. Register all 3 in `src/index.ts`.

**Build, commit:**
```bash
git add src/tools/adGroupTools.ts src/tools/creativeTools.ts src/tools/campaignTools.ts src/index.ts
git commit -m "feat: add ad-group, creative, and campaign tools"
```

---

## Task 4: Channel, site, publisher tools

**Files:** Create `src/tools/channelTools.ts`, `src/tools/siteTools.ts`, `src/tools/publisherTools.ts`

### channelTools.ts — export `registerChannelTools`
- `list_channels` — `GET /api/channels`, limit/offset
- `get_channel` — `GET /api/channels/{id}`
- `get_channel_parents` — `GET /api/channels/{id}/parents`

### siteTools.ts — export `registerSiteTools`
- `list_sites` — `GET /api/sites`, limit/offset
- `get_site` — `GET /api/sites/{id}`
- `get_site_parents` — `GET /api/sites/{id}/parents`

### publisherTools.ts — export `registerPublisherTools`
- `list_publishers` — `GET /api/publishers`, limit/offset
- `get_publisher` — `GET /api/publishers/{id}`

Register all 3 in `src/index.ts`.

**Build, commit:**
```bash
git add src/tools/channelTools.ts src/tools/siteTools.ts src/tools/publisherTools.ts src/index.ts
git commit -m "feat: add channel, site, and publisher tools"
```

---

## Task 5: `zone_load_trace` composite

**File:** Modify `src/tools/zoneTools.ts` — add `zone_load_trace` inside `registerZoneTools`

This is the flagship composite. It fans out across the API in 3 parallel rounds and returns a single structured blob.

### Input
```ts
z.object({ zoneId: z.string().describe("Zone ID to trace") }).strict()
```

### Execution flow

```ts
async ({ zoneId }) => {
  // auth guard (standard pattern)...

  try {
    // Round 1: 4 parallel calls
    const [zoneResp, parentsResp, adsResp, debugResp] = await Promise.all([
      workApiRequest<Record<string, unknown>>(v.session, "GET", `/api/zones/${zoneId}`),
      workApiRequest<Record<string, unknown>>(v.session, "GET", `/api/zones/${zoneId}/parents`),
      workApiRequest<Record<string, unknown>>(v.session, "GET", "/api/ads/ad", { params: { zoneId } }),
      workApiRequest<Record<string, unknown>>(v.session, "GET", "/api/ads/ad/debug", { params: { zoneId } }),
    ]);

    // Extract matched ad IDs from serving response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adsData = (adsResp as any).data ?? adsResp;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matchedAds: Array<{ id: string }> = Array.isArray((adsData as any).ads)
      ? (adsData as any).ads
      : [];

    // Round 2: fetch full ad + creative details in parallel
    const [adDetails, creativeDetails] = await Promise.all([
      Promise.all(
        matchedAds.map(ad =>
          workApiRequest<Record<string, unknown>>(v.session, "GET", `/api/ads/${ad.id}`).catch(() => ({ id: ad.id, error: "fetch failed" }))
        )
      ),
      Promise.all(
        matchedAds.map(ad =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          workApiRequest<Record<string, unknown>>(v.session, "GET", `/api/creatives`, { params: { adId: ad.id, limit: 10 } }).catch(() => ({ id: ad.id, error: "fetch failed" }))
        )
      ),
    ]);

    // Round 3: fetch zone template (from serving response)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const templateId: string | undefined = (adsData as any).template?.id ?? (adsData as any).templateId;
    const templateDetails = templateId
      ? await workApiRequest<Record<string, unknown>>(v.session, "GET", `/api/templates/${templateId}`).catch(() => ({ id: templateId, error: "fetch failed" }))
      : null;

    // Build summary string
    const matchCount = matchedAds.length;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const zoneName: string = (((zoneResp as any).data ?? zoneResp) as any).name ?? zoneId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const debugData = (debugResp as any).data ?? debugResp;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rejectedCount: number = Array.isArray((debugData as any).rejected) ? (debugData as any).rejected.length : 0;
    const summary = `Zone "${zoneName}" (${zoneId}): ${matchCount} ad(s) matched, ${rejectedCount} rejected.${templateId ? ` Template: ${templateId}.` : " No template detected."}`;

    const result = {
      zone: (zoneResp as any).data ?? zoneResp,
      parents: (parentsResp as any).data ?? parentsResp,
      matching: {
        matched: matchedAds,
        debug: debugData,
      },
      ads: adDetails,
      creatives: creativeDetails,
      template: templateDetails,
      summary,
    };

    const text = JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
  }
}
```

### Annotations
```ts
annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
```
(`idempotentHint: false` because it makes multiple downstream API calls)

### Description
```
Fan-out zone diagnostic tool. Given a zone ID, makes parallel API calls to fetch:
- Zone config and parent hierarchy (site → channel → publisher → network)
- Ads that would serve in this zone (via the ad-serving endpoint)
- Debug data explaining which ad-groups matched and which were rejected
- Full details for each matched ad
- The template the zone uses

Returns one structured blob for LLM analysis plus a human-readable 'summary' field.

Use this first when debugging why a zone is or isn't serving ads.
```

**Build, commit:**
```bash
git add src/tools/zoneTools.ts
git commit -m "feat: add zone_load_trace composite tool"
```

---

## Task 6: Final registration, build, and CLAUDE.md

- [ ] Verify all 8 tool files are imported and registered in `src/index.ts`
- [ ] Run `npm run build` — must be zero errors
- [ ] Update CLAUDE.md: add M2 tools to the "Implemented Tools" section (append below the M1 section)
- [ ] Commit: `git add src/index.ts CLAUDE.md && git commit -m "docs: register M2 tools and update CLAUDE.md"`

### CLAUDE.md addition (append after Creative Asset Groups section):

```markdown
### Zones (M2)
- `list_zones` — `GET /api/zones` (paginated)
- `get_zone` — `GET /api/zones/{id}`
- `get_zone_parents` — `GET /api/zones/{id}/parents`
- `get_zone_report` — `GET /api/zones/{id}/report` (params: resolution, startDate, endDate)
- `zone_load_trace` — composite: fan-out across zone + parents + ads/ad + debug + creatives + template → structured diagnostic blob

### Ads (M2)
- `list_ads` — `GET /api/ads` (paginated)
- `get_ad` — `GET /api/ads/{id}`
- `get_ad_parents` — `GET /api/ads/{id}/parents`
- `get_zone_ads` — `GET /api/ads/ad?zoneId=` — ad-serving endpoint, returns { ads, template }

### Ad Groups (M2)
- `list_ad_groups` — `GET /api/ad-groups` (paginated)
- `get_ad_group` — `GET /api/ad-groups/{id}`
- `get_ad_group_parents` — `GET /api/ad-groups/{id}/parents`

### Creatives (M2)
- `list_creatives` — `GET /api/creatives` (paginated)
- `get_creative` — `GET /api/creatives/{id}`
- `get_creative_parents` — `GET /api/creatives/{id}/parents`

### Campaigns (M2)
- `list_campaigns` — `GET /api/campaigns` (paginated)
- `get_campaign` — `GET /api/campaigns/{id}`
- `get_campaign_parents` — `GET /api/campaigns/{id}/parents`

### Channels (M2)
- `list_channels` — `GET /api/channels` (paginated)
- `get_channel` — `GET /api/channels/{id}`
- `get_channel_parents` — `GET /api/channels/{id}/parents`

### Sites (M2)
- `list_sites` — `GET /api/sites` (paginated)
- `get_site` — `GET /api/sites/{id}`
- `get_site_parents` — `GET /api/sites/{id}/parents`

### Publishers (M2)
- `list_publishers` — `GET /api/publishers` (paginated)
- `get_publisher` — `GET /api/publishers/{id}`
```

---

## Open Decisions (confirm on first API hit)

- `GET /api/ads/ad` response shape — plan assumes `{ ads: [{ id }], template: { id } }`. Adjust `zone_load_trace` Round 2/3 extraction if shape differs.
- `GET /api/ads/ad/debug` response shape — plan assumes `{ data: { rejected: [...] } }`. Adjust summary if differs.
- Creatives endpoint filter — plan uses `?adId=` param. Confirm actual filter param name once API is hit.
