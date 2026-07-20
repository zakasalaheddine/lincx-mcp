# Zone Targeting Inventory Composite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP tool `get_zone_targeting_inventory(zoneId, mode)` that does the whole "which ad groups are directly targeted to a zone and is each fully live" audit server-side, and simplify the `lincx-inventory` plugin's `/zone-targeted` into a thin presenter of it.

**Architecture:** One MCP composite (mirrors `report_query`): session guard → 5 full-set internal GETs in parallel → pure in-memory join/rollup → compact `structuredContent` + text. The Work API returns every row of a list endpoint in one response (the MCP normally slices client-side to fit the LLM guard), so there is NO server-side pagination — the "1150-row scan" is a single internal GET the LLM never sees. Pure `selectTargeting`/`rollupZoneTargeting` are unit-tested; the thin handler is verified by build + live check, matching how `report_query` is tested.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import extensions), vitest (`src/tests/**/*.test.ts`), `@modelcontextprotocol/sdk`, `zod`. Marketplace side: Claude Code plugin (skill markdown + node scripts).

## Global Constraints

- **Two repos, one PR each.** MCP work → repo `/Users/salaheddinezaka/Documents/work/mcp`, branch `feat/zone-targeting-inventory-composite` (new PR). Plugin work → repo `/Users/salaheddinezaka/Documents/work/lincx-marketplace`, branch `feat/lincx-inventory-zone-targeted` (existing PR #3, push updates).
- **MCP thin-tool rules (CLAUDE.md):** never `console.log` (use `console.error`); `networkId` never a tool param — it comes from the session via `workApiRequest`; every business tool calls `resolveLincxSession` then `validateSession` before any Work API call; imports use `.js` extension; `z.object({}).strict()`; `as const` on `type: "text"`; return `{ content: [{ type: "text", text }], structuredContent? }`. This composite is a deliberate, sanctioned exception to "one tool ≈ one API call", like `report_query`.
- **Enabled gate at every level:** `enabled === true && archived !== true`; a missing `archived` key means not archived.
- **`has_live_viable_ad` is a per-ad conjunction:** some SINGLE ad is on AND its `creativeId` resolves to a creative that is not archived. Never combine "some enabled ad" with "some resolving creative" across different ads.
- **Creative viability:** creatives have no `enabled` field but carry `archived` — viable = resolves AND not archived.
- **`exceptParams.zoneId` = exclusion:** zone only in `exceptParams` → not targeted; zone in both `params.zoneId` and `exceptParams.zoneId` → `conflicting` (excluded, surfaced separately).
- **Commit after each task.** Conventional Commits, body ends `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## Verified data shapes (live 2026-07-20)

- ad group: `{ id, name, enabled, archived?, params:{zoneId?:string[]}, exceptParams?:{zoneId?:string[]}, campaignId, creativeAssetGroupId }`
- campaign: `{ id, enabled, archived? }`  ·  ad: `{ id, adGroupId, enabled, archived?, creativeId }`  ·  creative: `{ id, archived? }`
- Every list GET returns ALL rows (`/api/ad-groups` 1150, `/api/campaigns` 664, `/api/ads` 1331, `/api/creatives` 1343). Raw list shape may be a bare array or `{ data:[...] }`/`{ items:[...] }` — extract tolerantly.

## File Structure

- `src/tools/zoneInventoryTools.ts` — exports `selectTargeting`, `rollupZoneTargeting` (pure), `registerZoneInventoryTools`. The tool's only real logic is the two pure functions; the handler is thin orchestration.
- `src/tests/zoneInventory.test.ts` — vitest unit tests on the pure functions.
- `src/index.ts` — import + register the tool group.
- `CLAUDE.md` — document the new tool.
- (marketplace) `plugins/lincx-inventory/skills/zone-targeted/SKILL.md` — rewritten thin.
- (marketplace) delete `scripts/zone-inventory-rollup.mjs` + `tests/zone-inventory-rollup.test.mjs`; update `scripts/check-plugin.mjs`.

---

## Task 1: Pure `selectTargeting` + `rollupZoneTargeting`

**Files:**
- Create: `src/tools/zoneInventoryTools.ts` (pure functions only this task)
- Test: `src/tests/zoneInventory.test.ts`

**Interfaces:**
- Produces:
  - `selectTargeting(adGroups, zoneId) → { targeted: AdGroup[], conflicting: AdGroup[] }`
  - `rollupZoneTargeting(args) → { groups: Row[], summary }` where
    `args = { zoneCag, targeted, conflicting, campaigns, adsByGroup, creatives, mode }`
  - Types (exported):
    - `AdGroup = { id: string; name?: string; enabled?: boolean; archived?: boolean; params?: { zoneId?: string[] }; exceptParams?: { zoneId?: string[] }; campaignId?: string; creativeAssetGroupId?: string }`
    - `Campaign = { enabled?: boolean; archived?: boolean }`
    - `Ad = { id?: string; enabled?: boolean; archived?: boolean; creativeId?: string }`
    - `Creative = { archived?: boolean }`
    - `Row = { id, name, archived, campaign_on, adgroup_on, has_enabled_ad, creative_resolves, has_live_viable_ad, fully_live, off_reason: string[] }`
    - `mode: 'all' | 'live' | 'off'`

- [ ] **Step 1: Write the failing test**

Create `src/tests/zoneInventory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { selectTargeting, rollupZoneTargeting, type AdGroup } from "../tools/zoneInventoryTools.js";

const ZONE = "8z7wzb";
const CAG = "0bckt2";

const ag = (over: Partial<AdGroup> = {}): AdGroup => ({
  id: "ag1", name: "AG1", enabled: true,
  params: { zoneId: [ZONE] }, campaignId: "c1", creativeAssetGroupId: CAG,
  ...over,
});

describe("selectTargeting", () => {
  it("keeps groups whose params.zoneId includes the zone", () => {
    const { targeted, conflicting } = selectTargeting(
      [ag({ id: "a" }), ag({ id: "b", params: { zoneId: ["other"] } })], ZONE);
    expect(targeted.map((g) => g.id)).toEqual(["a"]);
    expect(conflicting).toEqual([]);
  });
  it("ignores a group with the zone only in exceptParams", () => {
    const { targeted } = selectTargeting(
      [ag({ id: "x", params: { zoneId: ["other"] }, exceptParams: { zoneId: [ZONE] } })], ZONE);
    expect(targeted).toEqual([]);
  });
  it("flags zone-in-both as conflicting, not targeted", () => {
    const { targeted, conflicting } = selectTargeting(
      [ag({ id: "y", params: { zoneId: [ZONE] }, exceptParams: { zoneId: [ZONE] } })], ZONE);
    expect(targeted).toEqual([]);
    expect(conflicting.map((g) => g.id)).toEqual(["y"]);
  });
});

const base = (over: Partial<Parameters<typeof rollupZoneTargeting>[0]> = {}) =>
  rollupZoneTargeting({
    zoneCag: CAG,
    targeted: [ag()],
    conflicting: [],
    campaigns: { c1: { enabled: true } },
    adsByGroup: { ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }] },
    creatives: { cr1: {} },
    mode: "all",
    ...over,
  });

describe("rollupZoneTargeting", () => {
  it("fully_live when campaign, ad group, and a live+viable ad are all on", () => {
    const { groups, summary } = base();
    expect(groups[0].fully_live).toBe(true);
    expect(groups[0].off_reason).toEqual([]);
    expect(summary).toMatchObject({ targeted: 1, live: 1, off: 0 });
  });
  it("campaign off → off_reason names campaign", () => {
    const { groups } = base({ campaigns: { c1: { enabled: false } } });
    expect(groups[0].campaign_on).toBe(false);
    expect(groups[0].fully_live).toBe(false);
    expect(groups[0].off_reason).toEqual(["campaign"]);
  });
  it("ad group enabled but archived → forced off, off_reason names archived", () => {
    const { groups, summary } = base({ targeted: [ag({ enabled: true, archived: true })] });
    expect(groups[0].archived).toBe(true);
    expect(groups[0].adgroup_on).toBe(false);
    expect(groups[0].off_reason).toEqual(["archived"]);
    expect(summary.archived).toBe(1);
  });
  it("per-ad conjunction: enabled ad w/ dangling creative + disabled ad w/ valid creative → NOT live-viable", () => {
    const { groups } = base({
      adsByGroup: { ag1: [
        { id: "ad1", enabled: true, creativeId: "missing" },
        { id: "ad2", enabled: false, creativeId: "cr1" },
      ] },
      creatives: { cr1: {} },
    });
    expect(groups[0].has_enabled_ad).toBe(true);
    expect(groups[0].creative_resolves).toBe(true);
    expect(groups[0].has_live_viable_ad).toBe(false);
    expect(groups[0].off_reason).toEqual(["no_live_viable_ad"]);
  });
  it("archived creative does not count as viable", () => {
    const { groups } = base({ creatives: { cr1: { archived: true } } });
    expect(groups[0].has_live_viable_ad).toBe(false);
  });
  it("archived ad is not a live ad", () => {
    const { groups } = base({ adsByGroup: { ag1: [{ id: "ad1", enabled: true, archived: true, creativeId: "cr1" }] } });
    expect(groups[0].has_live_viable_ad).toBe(false);
  });
  it("mode 'off' returns only not-fully-live rows", () => {
    const { groups } = base({
      targeted: [ag({ id: "ag1" }), ag({ id: "ag2", campaignId: "c2" })],
      campaigns: { c1: { enabled: true }, c2: { enabled: false } },
      adsByGroup: {
        ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }],
        ag2: [{ id: "ad2", enabled: true, creativeId: "cr1" }],
      },
      mode: "off",
    });
    expect(groups.map((g) => g.id)).toEqual(["ag2"]);
  });
  it("summary counts are over the full targeted set regardless of mode filter", () => {
    const { summary } = base({
      targeted: [ag({ id: "ag1" }), ag({ id: "ag2", campaignId: "c2" })],
      campaigns: { c1: { enabled: true }, c2: { enabled: false } },
      adsByGroup: {
        ag1: [{ id: "ad1", enabled: true, creativeId: "cr1" }],
        ag2: [{ id: "ad2", enabled: true, creativeId: "cr1" }],
      },
      mode: "live",
    });
    expect(summary).toMatchObject({ targeted: 2, live: 1, off: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/zoneInventory.test.ts`
Expected: FAIL — cannot find module / `selectTargeting` not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/tools/zoneInventoryTools.ts` with ONLY the pure functions and types for now (the handler is Task 2):

```ts
/**
 * tools/zoneInventoryTools.ts
 *
 * get_zone_targeting_inventory — composite: which ad groups are DIRECTLY targeted
 * to a zone, and is each fully live (campaign + ad group + a live ad with a viable
 * creative)? Second sanctioned server-side composite alongside report_query — it
 * fetches whole-network list sets internally and returns only the compact matched
 * rollup, so no ad-group rows are ever paged through the LLM.
 */

export type AdGroup = {
  id: string; name?: string; enabled?: boolean; archived?: boolean;
  params?: { zoneId?: string[] }; exceptParams?: { zoneId?: string[] };
  campaignId?: string; creativeAssetGroupId?: string;
};
export type Campaign = { enabled?: boolean; archived?: boolean };
export type Ad = { id?: string; enabled?: boolean; archived?: boolean; creativeId?: string };
export type Creative = { archived?: boolean };
export type Mode = "all" | "live" | "off";
export type Row = {
  id: string; name: string; archived: boolean;
  campaign_on: boolean; adgroup_on: boolean; has_enabled_ad: boolean;
  creative_resolves: boolean; has_live_viable_ad: boolean;
  fully_live: boolean; off_reason: string[];
};
export type Summary = { targeted: number; live: number; off: number; archived: number; conflicting: number };

// A level is "on" only if enabled and not archived. archived is omitted when
// false, so `!== true` treats a missing key as false.
const on = (x: { enabled?: boolean; archived?: boolean } | undefined): boolean =>
  !!x && x.enabled === true && x.archived !== true;

const has = (arr: string[] | undefined, v: string): boolean => Array.isArray(arr) && arr.includes(v);

/** Split ad groups into those directly targeting the zone and those that both
 * target and except it (conflicting). exceptParams-only groups are neither. */
export function selectTargeting(adGroups: AdGroup[], zoneId: string): { targeted: AdGroup[]; conflicting: AdGroup[] } {
  const targeted: AdGroup[] = [];
  const conflicting: AdGroup[] = [];
  for (const ag of adGroups) {
    const inParams = has(ag.params?.zoneId, zoneId);
    const inExcept = has(ag.exceptParams?.zoneId, zoneId);
    if (inParams && inExcept) conflicting.push(ag);
    else if (inParams) targeted.push(ag);
  }
  return { targeted, conflicting };
}

/** Roll up enabled-state across campaign → ad group → ad → creative for each
 * targeted ad group. Filters rows by mode; summary is always over the full set. */
export function rollupZoneTargeting(args: {
  zoneCag?: string;
  targeted: AdGroup[];
  conflicting: AdGroup[];
  campaigns: Record<string, Campaign>;
  adsByGroup: Record<string, Ad[]>;
  creatives: Record<string, Creative>;
  mode: Mode;
}): { groups: Row[]; summary: Summary } {
  const { targeted, conflicting, campaigns, adsByGroup, creatives, mode } = args;
  // Viable = ad's creative resolves to an existing, non-archived creative.
  const creativeViable = (creativeId?: string): boolean => {
    if (creativeId === undefined) return false;
    const c = creatives[creativeId];
    return c !== undefined && c.archived !== true;
  };
  const creativeResolves = (creativeId?: string): boolean =>
    creativeId !== undefined && creatives[creativeId] !== undefined;

  const all: Row[] = targeted.map((ag) => {
    const campaign = ag.campaignId !== undefined ? campaigns[ag.campaignId] : undefined;
    const ads = adsByGroup[ag.id] ?? [];

    const campaign_on = on(campaign);
    const adgroup_on = on(ag);
    const has_enabled_ad = ads.some(on);
    const creative_resolves = ads.some((a) => creativeResolves(a.creativeId));
    const has_live_viable_ad = ads.some((a) => on(a) && creativeViable(a.creativeId));
    const archived = ag.archived === true;

    const off_reason: string[] = [];
    if (!campaign_on) off_reason.push("campaign");
    if (!adgroup_on) off_reason.push(archived ? "archived" : "adgroup");
    if (!has_live_viable_ad) off_reason.push("no_live_viable_ad");

    const fully_live = campaign_on && adgroup_on && has_live_viable_ad;
    return {
      id: ag.id, name: ag.name ?? ag.id, archived,
      campaign_on, adgroup_on, has_enabled_ad, creative_resolves, has_live_viable_ad,
      fully_live, off_reason,
    };
  });

  const summary: Summary = {
    targeted: all.length,
    live: all.filter((r) => r.fully_live).length,
    off: all.filter((r) => !r.fully_live).length,
    archived: all.filter((r) => r.archived).length,
    conflicting: conflicting.length,
  };

  const groups = mode === "live" ? all.filter((r) => r.fully_live)
    : mode === "off" ? all.filter((r) => !r.fully_live)
    : all;

  return { groups, summary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/zoneInventory.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/zoneInventoryTools.ts src/tests/zoneInventory.test.ts
git commit -m "feat(zone-inventory): pure zone-targeting selection + rollup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: The composite tool + registration + docs

**Files:**
- Modify: `src/tools/zoneInventoryTools.ts` (add imports, a list extractor, and `registerZoneInventoryTools`)
- Modify: `src/index.ts` (import + register)
- Modify: `CLAUDE.md` (document the tool)

**Interfaces:**
- Consumes: `selectTargeting`, `rollupZoneTargeting` from Task 1; `resolveLincxSession`, `validateSession`, `workApiRequest`, `handleWorkApiError`; `RESPONSE_SIZE_LIMIT`.
- Produces: MCP tool `get_zone_targeting_inventory`; `registerZoneInventoryTools(server)`.

- [ ] **Step 1: Add imports + a tolerant list extractor at the top of `zoneInventoryTools.ts`**

Insert after the file's doc comment, before the type exports:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError } from "../services/workApi.js";
import { RESPONSE_SIZE_LIMIT } from "../constants.js";

/** Pull the row array out of an unknown list response (bare array, {data:[]}, {items:[]}). */
function asRows<T = Record<string, unknown>>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of Object.keys(obj)) if (Array.isArray(obj[k])) return obj[k] as T[];
  }
  return [];
}

/** Unwrap a single-entity response that may be `{ data: {...} }` or the bare object. */
function asEntity(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) return obj.data as Record<string, unknown>;
    return obj;
  }
  return {};
}
```

- [ ] **Step 2: Append `registerZoneInventoryTools` to `zoneInventoryTools.ts`**

```ts
export function registerZoneInventoryTools(server: McpServer): void {
  server.registerTool("get_zone_targeting_inventory", {
    title: "Zone Targeting Inventory",
    description: `Audit which ad groups are DIRECTLY targeted to a zone (via the ad group's params.zoneId) and, for each, whether it is FULLY LIVE — campaign, ad group, and at least one ad all enabled (and not archived) with a viable creative attached — or where it is off. Exhaustive and server-side: it scans the whole network's ad groups/campaigns/ads/creatives internally and returns only the compact matched rollup, so nothing is paged through the model. exceptParams.zoneId is treated as an exclusion (a group that both targets and excepts the zone is reported under 'conflicting', not 'targeted').`,
    inputSchema: z.object({
      zoneId: z.string().describe("Zone ID to audit targeting for"),
      mode: z.enum(["all", "live", "off"]).default("all").describe("Filter the returned groups: all (default), only fully-live, or only not-fully-live. Summary counts always cover the full targeted set."),
    }).strict(),
    outputSchema: z.object({
      zone: z.object({ id: z.string(), name: z.string(), creativeAssetGroupId: z.string().optional(), templateId: z.string().optional() }),
      mode: z.enum(["all", "live", "off"]),
      summary: z.object({ targeted: z.number(), live: z.number(), off: z.number(), archived: z.number(), conflicting: z.number() }),
      groups: z.array(z.record(z.unknown())),
      conflicting: z.array(z.object({ id: z.string(), name: z.string() })),
      scan: z.object({ adGroupsScanned: z.number(), campaignsScanned: z.number(), adsScanned: z.number(), creativesScanned: z.number() }),
      groupsTruncated: z.object({ returned: z.number(), total: z.number(), note: z.string() }).optional(),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ zoneId, mode }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };
    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
    const session = v.session;

    try {
      // Every list endpoint returns the full network set in one call; fetch in parallel.
      const [zoneRaw, adGroupsRaw, campaignsRaw, adsRaw, creativesRaw] = await Promise.all([
        workApiRequest<unknown>(session, "GET", `/api/zones/${zoneId}`),
        workApiRequest<unknown>(session, "GET", "/api/ad-groups"),
        workApiRequest<unknown>(session, "GET", "/api/campaigns"),
        workApiRequest<unknown>(session, "GET", "/api/ads"),
        workApiRequest<unknown>(session, "GET", "/api/creatives"),
      ]);

      const zone = asEntity(zoneRaw);
      if (!zone.id) return { content: [{ type: "text" as const, text: "Error: Resource not found. Double-check the zone ID." }] };

      const adGroups = asRows<AdGroup>(adGroupsRaw);
      const campaignRows = asRows<{ id: string; enabled?: boolean; archived?: boolean }>(campaignsRaw);
      const adRows = asRows<Ad & { adGroupId?: string }>(adsRaw);
      const creativeRows = asRows<{ id: string; archived?: boolean }>(creativesRaw);

      const campaigns: Record<string, Campaign> = {};
      for (const c of campaignRows) if (c.id) campaigns[c.id] = { enabled: c.enabled, archived: c.archived };
      const creatives: Record<string, Creative> = {};
      for (const c of creativeRows) if (c.id) creatives[c.id] = { archived: c.archived };
      const adsByGroup: Record<string, Ad[]> = {};
      for (const a of adRows) {
        if (!a.adGroupId) continue;
        (adsByGroup[a.adGroupId] ??= []).push({ id: a.id, enabled: a.enabled, archived: a.archived, creativeId: a.creativeId });
      }

      const { targeted, conflicting } = selectTargeting(adGroups, zoneId);
      const { groups, summary } = rollupZoneTargeting({
        zoneCag: zone.creativeAssetGroupId as string | undefined,
        targeted, conflicting, campaigns, adsByGroup, creatives, mode,
      });

      const structuredBase = {
        zone: {
          id: String(zone.id),
          name: String(zone.name ?? zone.id),
          creativeAssetGroupId: zone.creativeAssetGroupId as string | undefined,
          templateId: zone.templateId as string | undefined,
        },
        mode,
        summary,
        conflicting: conflicting.map((g) => ({ id: g.id, name: g.name ?? g.id })),
        scan: {
          adGroupsScanned: adGroups.length,
          campaignsScanned: campaignRows.length,
          adsScanned: adRows.length,
          creativesScanned: creativeRows.length,
        },
      };

      // Cap the groups array so the serialized result stays under the size guard
      // (carried ~2.5× via content text + structuredContent), keeping off rows and
      // then live rows. Mega-zones are rare; graceful, not a hard error.
      const overhead = JSON.stringify(structuredBase).length + 200;
      const budget = Math.floor((RESPONSE_SIZE_LIMIT - overhead) / 2.5);
      const kept: Row[] = [];
      let used = 0;
      for (const g of groups) {
        used += JSON.stringify(g).length + 1;
        if (used > budget && kept.length > 0) break;
        kept.push(g);
      }
      const groupsTruncated = kept.length < groups.length
        ? { returned: kept.length, total: groups.length, note: "Groups capped to fit the response size limit. Use mode 'off' or 'live' to narrow, or raise RESPONSE_SIZE_LIMIT." }
        : undefined;

      const structured = { ...structuredBase, groups: kept, ...(groupsTruncated ? { groupsTruncated } : {}) };
      const header = `Zone ${structured.zone.name} (${structured.zone.id}) — ${summary.targeted} targeted · ${summary.live} live · ${summary.off} off · ${summary.archived} archived · ${summary.conflicting} conflicting${groupsTruncated ? ` — showing ${kept.length}/${groups.length}` : ""}`;
      return {
        content: [{ type: "text" as const, text: `${header}\n\n${JSON.stringify(structured)}` }],
        structuredContent: structured,
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

- [ ] **Step 3: Register in `src/index.ts`**

Add the import next to the other tool imports (after line 31, the reporting import):

```ts
import { registerZoneInventoryTools } from "./tools/zoneInventoryTools.js";
```

Add the registration call after `registerReportingTools(server);` (line ~71):

```ts
  registerZoneInventoryTools(server);
```

- [ ] **Step 4: Typecheck / build**

Run: `npm run build`
Expected: `tsc` exits 0, no type errors.

- [ ] **Step 5: Run the whole test suite**

Run: `npm test`
Expected: all suites pass, including `zoneInventory.test.ts`.

- [ ] **Step 6: Document the tool in `CLAUDE.md`**

Under `## Implemented Tools`, add a new subsection after the Reporting block:

```markdown
### Zone Inventory (composite)
- `get_zone_targeting_inventory` — composite: which ad groups are DIRECTLY targeted to a zone (via `params.zoneId`) and whether each is fully live (campaign + ad group + a live ad with a viable, non-archived creative), or where it's off. Scans the whole network's ad-groups/campaigns/ads/creatives **internally** (each list GET returns the full set) and returns only the compact matched rollup — nothing is paged through the model. `exceptParams.zoneId` = exclusion (a group targeting AND excepting the zone is reported as `conflicting`). The **second sanctioned server-side composite** alongside `report_query` — the deliberate exception to the one-tool-≈-one-call rule, justified the same way (never dump a whole entity list into context).
```

- [ ] **Step 7: Commit**

```bash
git add src/tools/zoneInventoryTools.ts src/index.ts CLAUDE.md
git commit -m "feat(zone-inventory): get_zone_targeting_inventory composite tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: MCP PR

**Files:** none (PR only).

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feat/zone-targeting-inventory-composite`

- [ ] **Step 2: Open the PR**

Run `gh pr create --base main --head feat/zone-targeting-inventory-composite` with title
`feat(zone-inventory): get_zone_targeting_inventory server-side composite` and a body summarizing: the problem (client-side scan blew the LLM context / 30k guard), the enabler (list endpoints return full sets; internal calls bypass the guard), the tool contract, that it's the 2nd sanctioned composite alongside `report_query`, and the test coverage. End the body with the Claude Code footer.

Expected: prints the PR URL. Record it.

---

## Task 4: Simplify the `lincx-inventory` plugin to a thin presenter

**Repo:** `/Users/salaheddinezaka/Documents/work/lincx-marketplace`, branch `feat/lincx-inventory-zone-targeted` (existing PR #3).

**Files:**
- Modify: `plugins/lincx-inventory/skills/zone-targeted/SKILL.md` (rewrite flow)
- Delete: `plugins/lincx-inventory/scripts/zone-inventory-rollup.mjs`
- Delete: `plugins/lincx-inventory/tests/zone-inventory-rollup.test.mjs`
- Modify: `plugins/lincx-inventory/scripts/check-plugin.mjs` (drop the deleted script from its asserts)

**Interfaces:**
- Consumes: the MCP tool `get_zone_targeting_inventory`; keeps `session-state.mjs` + the command unchanged.

- [ ] **Step 1: Rewrite `SKILL.md`**

Replace the entire `## Flow` section (and the now-irrelevant paging/rollup prose) so the body reads:

```markdown
# Lincx — Zone targeting inventory

Answer: "For zone Z, list every ad group **directly targeted** to it, and for each
whether it is **fully live** (campaign + ad group + ad all enabled with a viable
creative attached) or **where it is off**." Exhaustive.

## Inputs
- `zoneId` — required (the command resolves it, remembering the last one).
- `mode` — `all` (default) | `live` (only fully-live) | `off` (only not-fully-live).

## Flow

1. Call **`get_zone_targeting_inventory({ zoneId, mode })`**. It does the whole audit
   server-side and returns `{ zone, summary, groups[], conflicting[], scan }`
   (`groups[]` carry `campaign_on`, `adgroup_on`, `has_live_viable_ad`, `fully_live`,
   `off_reason`, `archived`). Do NOT scan ad groups yourself — the tool is exhaustive.
2. Render a markdown table from `groups`: one row per ad group with a ✅/❌ per level
   and the `off_reason` when not fully live. Head it with the zone name/CAG/template
   and the summary line (`N targeted · X live · Y off · Z archived · C conflicting`).
   If `summary.conflicting > 0`, list the `conflicting` groups below the table.
   If `groupsTruncated` is present, say so — do not imply the list is complete.

## Guardrails
- Never pass `networkId` — it is session-scoped upstream.
- On `"Error: Not authenticated…"` surface it and ask the user to run `auth_login`.
  On `"Error: Resource not found…"` the zone ID is wrong — do not invent one.

## Out of scope
"Free radicals" — ad groups targeting no zone that still render via the zone's shared
CAG. Eligibility, not direct targeting; a later `mode` on the composite.
```

Keep the YAML frontmatter (`name: zone-targeted`, description) unchanged.

- [ ] **Step 2: Delete the now-superseded helper + its test**

Run:
```bash
git rm plugins/lincx-inventory/scripts/zone-inventory-rollup.mjs \
       plugins/lincx-inventory/tests/zone-inventory-rollup.test.mjs
```

- [ ] **Step 3: Update `check-plugin.mjs`**

In `plugins/lincx-inventory/scripts/check-plugin.mjs`, remove `'scripts/zone-inventory-rollup.mjs'` from the required-paths list (the `for (const p of [ ... ])` block), leaving `scripts/session-state.mjs`, `commands/zone-targeted.md`, `skills/zone-targeted/SKILL.md`.

- [ ] **Step 4: Run the plugin suite**

Run: `bash plugins/lincx-inventory/tests/run-all.sh`
Expected: session-state tests pass, `✔ plugin structure ok`, `all tests passed` (the rollup test is gone; no failure).

- [ ] **Step 5: Commit + push (updates PR #3)**

```bash
git add -A
git commit -m "refactor(lincx-inventory): thin /zone-targeted over get_zone_targeting_inventory

Move the exhaustive scan + rollup server-side into the MCP composite; the skill now
calls the tool and renders. Deletes the client-side rollup helper + its test.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push
```

- [ ] **Step 6: Note the plugin change on PR #3**

Add a PR comment (`gh pr comment 3`) noting the plugin now depends on the new MCP tool `get_zone_targeting_inventory` (link the MCP PR from Task 3), and that the client-side scan/rollup was removed.
