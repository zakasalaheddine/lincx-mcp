# Zone eligibility join — design

> Next rung after `get_zone_targeting_inventory`. Two pieces:
> **(1)** a small `scoped_via` refinement on the existing inventory tool, and
> **(2)** a general **eligibility join** — one pure core, three read directions —
> that answers "what can serve in this zone", "which zones can this ad group leak
> into", and "why did X serve in this zone" as the same join, flipped.
>
> Date: 2026-07-22. Reference: network `7jdz0n` (Core Digital), zone `8z7wzb`,
> CAG `0bckt2`. Builds directly on
> `2026-07-20-zone-targeting-inventory-composite-design.md` (its "free radicals"
> out-of-scope note is what this promotes to a first-class primitive).

## Data model (confirmed live + from swagger)

Both **ad groups and ads** carry `params` and `exceptParams`, each an object of
`{ [key]: string[] }`; the key of interest is `zoneId`.

- `params.zoneId` — **whitelist**: the zone(s) this ad group / ad is targeted to.
- `exceptParams.zoneId` — **blacklist** (the opposite of `params`): zones this ad
  group / ad is explicitly excluded from, regardless of anything else.
- A zone and an ad group each carry `creativeAssetGroupId` (CAG). A zone renders
  the CAG's creatives via its template; an ad group whose CAG matches the zone's
  is **CAG-eligible** to be considered for that zone.

A level is **on** only if `enabled === true && archived !== true` (reuse the
existing `on()` helper; Work API omits `archived` when false).

---

## Part 1 — `scoped_via` on `get_zone_targeting_inventory` (annotate-only)

Add `scoped_via: string[]` to each `groups[]` row. **The selected row set is
unchanged** (still the ad groups whose `params.zoneId` names the zone and don't
except it — the same 83 on `8z7wzb`). `scoped_via` only labels *how each already-
selected row is scoped to the zone*, as an array because more than one can apply:

| value | condition |
|---|---|
| `ad-group-whitelist` | `zone ∈ adGroup.params.zoneId` — always present (it's the selection criterion) |
| `ad-level-whitelist` | some ad in the group has `zone ∈ ad.params.zoneId` |
| `zone-selection` | `zone.creativeAssetGroupId === adGroup.creativeAssetGroupId` (CAG match) |

Pure `rollupZoneTargeting` already has `adsByGroup` and the zone CAG in scope, so
this is: one field on `Row`, a few lines in the rollup, and updates to the tool
`description`, the design/plan docs, and the unit test. **No new fetch.**

---

## Part 2 — the general eligibility join

### Pure core (network-agnostic)

```ts
// tools/eligibility.ts (pure, exported for tests)
type Eligibility = {
  adGroupId: string;
  zoneId: string;
  eligible: boolean;
  via: string[];         // 'ad-group-whitelist' | 'ad-level-whitelist' | 'zone-selection'
  excluded: boolean;     // blacklisted via exceptParams
  reasons: string[];     // why not eligible (e.g. 'cag-mismatch', 'blacklisted', 'targets-other-zones')
  conflicts: string[];   // config contradictions — see below
};

function eligibility(adGroup, zone, ctx: { adsByGroup }): Eligibility
```

The core takes **already-fetched row sets as arguments** and never reads
`activeNetworkId` itself. That is deliberate: a future team-vs-client / multi-
network access layer feeds it a different set per network without touching the
join. No single-tenant assumption is baked into the primitive.

### Eligibility predicate

An ad group is **eligible** to serve in a zone when **all** hold:

1. **CAG match** — `zone.creativeAssetGroupId === adGroup.creativeAssetGroupId`.
2. **Not blacklisted** — `zone ∉ adGroup.exceptParams.zoneId` (and, for a specific
   ad, `zone ∉ ad.exceptParams.zoneId`). Blacklist always wins.
3. **In scope** — at least one of:
   - `zone ∈ adGroup.params.zoneId` (ad-group whitelist), OR
   - `zone ∈ ad.params.zoneId` for some ad (ad-level whitelist), OR
   - **the ad group targets zero zones** (`params.zoneId` empty/absent) → open
     within its CAG → **free radical**.

   An ad group that targets *some other* zone(s) but not this one is **scoped
   out** (`reasons: ['targets-other-zones']`), not a free radical.

**Free radical** = eligible with `via === ['zone-selection']` only (no whitelist)
because the group targets zero zones. This is the leak the reviewer scoped
earlier: renders via the shared CAG despite no direct targeting.

### `conflicts[]` (reserved, populate the obvious now)

A place for config-contradiction signals so downstream (and a later audit rung)
can surface them. Populate now:

- `targets-and-excepts` — `zone ∈ params.zoneId` **and** `zone ∈ exceptParams.zoneId`
  (this is `get_zone_targeting_inventory`'s existing `conflicting` bucket, now a
  first-class signal on the join).
- `whitelisted-cag-mismatch` — `zone ∈ params.zoneId` but `zone.CAG !== adGroup.CAG`
  (targeted at a zone it can't actually render in).

Leave the array open for future signals (ad-level vs ad-group whitelist
contradictions, etc.). Empty array = no conflicts.

### Three thin tools over the one core

1. **`get_zone_eligible_ad_groups(zoneId)`** — flips `get_zone_targeting_inventory`:
   everything *eligible* in a zone, split `directlyTargeted[]` (any whitelist) vs
   `freeRadicals[]` (zone-selection only, untargeted), each carrying the existing
   live rollup (`fully_live`, `off_reason`, …) so the same table renders.
2. **`get_ad_group_zone_reach(adGroupId)`** — "which zones can this ad group leak
   into": the flip. Direct-target zones + free-radical zones (same CAG, group
   targets zero zones), each with `via` and any `conflicts`.
3. **`explain_serve(zoneId, { adGroupId | adId })`** — the pair query: is this
   group/ad eligible in this zone, by what path (`via`), and if not, *why not*
   (`reasons`) + any `conflicts`. This is the "why did X serve in this zone"
   direction — the same join evaluated for a single pair.

All three are thin: session guard → the same whole-network GETs
`get_zone_targeting_inventory` already makes (`/api/zones`, `/api/ad-groups`,
`/api/campaigns`, `/api/ads`, `/api/creatives`) → run the pure `eligibility`
core → compact text + rollup envelope. Same size-fit discipline as the inventory
tool (never drop rows; shed `name`, then ids-only, before signalling
incomplete).

## Files

- `src/tools/zoneInventoryTools.ts` — Part 1 (`scoped_via` in `Row` + rollup).
- `src/tools/eligibility.ts` — Part 2 pure core (`eligibility`), exported for tests.
- `src/tools/zoneEligibilityTools.ts` — Part 2 registers the three thin tools.
- `src/index.ts` — register the new tool group.
- `test/eligibility.test.ts` — unit tests on the pure core: free-radical vs
  scoped-out vs whitelisted, blacklist wins, CAG-mismatch, both conflicts.
- `test/zoneInventory.test.ts` — extend for `scoped_via`.
- `CLAUDE.md` — add the new tools to the Implemented Tools list.

## Out of scope (built to extend)

- Ad-level rollup depth inside `get_zone_eligible_ad_groups` beyond what the
  existing inventory rollup already gives.
- A write/audit tool that acts on `conflicts[]` — this only surfaces them.
- The team-vs-client access layer itself — the core is *shaped* to accept it
  (network-agnostic inputs), but the layer is not built here.

## Cadence

Two issues, shipped one at a time (reviewer verifies each on handback):
Issue #1 = Part 1 (`scoped_via`), small, first. Issue #2 = Part 2 (eligibility
join), the real rung.
