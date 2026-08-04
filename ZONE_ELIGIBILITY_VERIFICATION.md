# Lincx MCP — Zone Eligibility Tooling Verification Log

**Network:** `7jdz0n` (Core Digital)
**Zones under test:** `8z7wzb` (Quicken Loans Refinance – Match, CAG `0bckt2`), `6wahzt` (Quicken Loans – Listicle – SmartSeniorSavings, CAG `fab2jc`)
**Tools under test:** `get_zone_targeting_inventory`, `get_zone_eligible_ad_groups`, `explain_serve`, `get_ad_group_zone_reach`, plus `get_ad`, `get_ad_group`, `get_zone`, `list_ads`, `list_ad_groups`, `list_zones`
**Dates of run:** 2026-08-03 (passes 0, A–F) and 2026-08-04 (passes G–I, defect fixes, exhaustive sweeps)
**Format:** each section reproduces the verification prompt as issued, followed by the result reported back from live API calls.

---

## Executive summary

Nine verification passes were run against the zone-eligibility tooling on production network `7jdz0n`. Every assertion with live data behind it passes.

The 08-04 session materially changed the status of the three items the 08-03 log left open. Two of them — the `ad-level-whitelist` and `ad-group-blacklist` enum branches — moved from **UNEXERCISED (no fixture found)** to **CONFIRMED ABSENT NETWORK-WIDE**, established by exhaustive sweeps of all 1,150 ad groups and all 1,331 ads rather than by inference from two zones. That is a terminal result: no further reading closes them, and both are already pinned by unit tests.

Reaching that result required fixing four tooling defects found during the sweeps, three of them blockers. All are shipped and verified live.

Two assertions in the original set were also found to be **worded in a way that will produce false failures** once fixtures exist. Both are corrected below (E1 and A1).

### Results at a glance

| Pass | Subject | Result |
|---|---|---|
| 0 | Paging contract — `page` object, `complete`, removal of `truncated` | **PASS** |
| A1–A3 | Inventory ↔ eligibility reconciliation (counts, id sets, field agreement) | **PASS** (wording corrected — see A1 note) |
| B5a–B5f | Multi-page integrity; paging continuity across buckets | **PASS** |
| C3 | `scoped_via` enum conformance across three tools | **PASS** (4 of 5 values exercised live as of pass K; only `ad-group-blacklist` unreachable) |
| D1, D2, D4 | Offer-grain arithmetic (sums, bounds, array/count agreement) | **PASS** |
| D5 | Free-radical ads carry no zone whitelist and no blacklist for the zone | **PASS** |
| D3 | Ad-level-targeted offer under an untargeted group | **CONFIRMED ABSENT** — was UNEXERCISED |
| E1–E4 | `reach()` ↔ bucket listing ↔ `explain_serve` agreement; CAG closure | **PASS** (E1 wording corrected) |
| E5 | `reasons[]` / `conflicts[]` on ineligible rows | **PARTIAL** — `conflicts[]` confirmed absent network-wide |
| F1 | Free-radical host ad-group config shape | **PASS** |
| F3 | `adFeedCount` reported as a serving parameter, not an eligibility count | **Reported** |
| G | Defect-fix smoke test (4 calls) | **PASS** |
| H | Exhaustive ad-group sweep for targets-and-excepts (1,150 groups) | **PASS — zero hits** |
| I | Exhaustive ad sweep for ad-level zone whitelists (1,331 ads) | **PASS — zero hits** |
| J | Cross-network probe for ad-level whitelists (25 of 63 networks) | **PASS** — 6 candidate networks found |
| K | Adnet (`xvret6`) — `ad-level-whitelist` + `adLevelTargeted` exercised live | **PASS** — C3 now 4 of 5 |

### Key confirmations

- **Nothing is silently dropped.** Targeted-but-broken ad groups stay in `directlyTargeted[]` with `eligible: false` and their `reasons[]`. On `8z7wzb`, 42 archived groups behave exactly this way.
- **Paging is lossless.** Across every bucket and both zones, `Σ page.returned == page.total`, with no duplicate and no skipped id at any page seam. The global offset in `bucket:"all"` carries continuously across the bucket boundary within a single response.
- **`summary` is always exact over the full set**, independent of `bucket` and `offset` — verified identical on all pages of every run.
- **The four tools agree.** `get_zone_targeting_inventory`, `get_zone_eligible_ad_groups`, `explain_serve`, and `get_ad_group_zone_reach` returned mutually consistent verdicts on every id sampled.
- **Every returned row keeps its full field set.** No row degrades to a bare id string at any zone size; oversize is handled by paging, not by shedding the offer payload.

### Operational notes for reviewers

- **`complete` is not an end-of-pages signal.** It is `true` only when one response holds the entire selected slice (offset 0 *and* no `next_offset`). The terminal page of a multi-page run correctly carries `complete: false`. Page on the absence of `next_offset`, never on `complete`.
- **`reach()` filters to eligible; the bucket listing does not.** Intended asymmetry — see the E1 correction.
- **`adFeedCount` is a serving parameter.** Never reconcile it against an eligibility count.
- **`unknown_fields` in a list envelope means the path matched no row in the whole collection** — i.e. your path is wrong, or the data genuinely doesn't use it. It is not a "field is rare" signal; sparse fields do not trigger it.
- **A redeploy drops MCP transport sessions.** OAuth tokens and the Lincx session persist in Redis, but `transports` is an in-memory map, so the client must re-initialize (toggle the connector) after a deploy. Symptom: `-32000 Bad Request: unknown or missing MCP session ID`.

### Open items (follow-up)

1. **`ad-level-whitelist` — now EXERCISED LIVE (pass K, Adnet).** `scoped_via` carries it and `adLevelTargetedOffers` reads 23. What remains unobserved is specifically the **D3 shape**: the whitelisted ad sitting under an *untargeted* group. Across two networks (Core Digital: no ad-level whitelists at all; Adnet: 25 groups with them) every such group is itself directly targeted. Fixture to close the remaining case: an ad group **not** targeted to the zone but on the zone's CAG, holding **≥1 untargeted ad** and **≥1 ad whose `params.zoneId` names the zone**. 38 networks remain unprobed (pass J) if you would rather find one than build one.
2. **`conflicts[]` / `ad-group-blacklist` — CONFIRMED ABSENT, fixture required for live coverage.** No ad group in `7jdz0n` names the same zone in both `params.zoneId` and `exceptParams.zoneId`. Established by exhaustive sweep (pass H). Fixture to close it: one ad group listing the same zone id in both keys. That single fixture also unblocks the stronger A1 (reconciliation with `conflicting` non-empty).
3. **Both fixtures are config changes, not engineering gaps.** Both branches are already pinned by unit tests in the repo, so a regression fails CI regardless of production data. Creating them buys live coverage of two branches, nothing more.
4. **`zoneId-position` semantics — open question for the platform team.** Three groups (`ggg7ww`, `hu4gni`, `qc3a2v`) exclude a zone at a specific slot via a `zoneId-position` key. The eligibility join reads `params.zoneId` / `exceptParams.zoneId` only and ignores it. Whether that is correct depends on what `filterAdgroups()` does with the key upstream.
5. **`ddbbai` — open question for the platform team.** It is simultaneously the network's most-blocklisted zone and a whitelist target on five groups (`ow6ets`, `ple7fj`, `quc2qz`, `t8fngw`, `9l1inq`). Not a tooling issue; worth a config review.
6. **Inert ad-level whitelists on Adnet — operational bug, separate ticket.** 18 ads across 8 groups whitelist a zone their parent group cannot reach, so the whitelist never fires (`filterAdgroups()` runs first). Six are live groups — Roofing, Windows, HELOC, Auto Insurance, Timeshare Exit, Solar Exit — where a `| fbz` ad names `upd39v` under a parent scoped to `hh4x9w` but not `upd39v`. Reads as a Facebook-zone carve-out rolled out across verticals with `upd39v` missed on the parent. Not a tooling defect; the tooling is what surfaced it. Candidate for a new `conflicts[]` signal (`inert-ad-level-whitelist`) if that surface is wanted.
7. **`ducqqp` data hygiene.** 232,813 bytes in one ad group, of which `params.zip` is 8,931 ZIP codes / 71,449 chars. Now handled gracefully by the tooling, but the underlying record is worth investigating.

---

## Defects found and fixed during verification

All shipped to `main` and verified live in pass G.

| # | Defect | Impact | Commit |
|---|---|---|---|
| 1 | Oversize response shed row bodies to bare id strings | The offer-grain payload — the entire reason to call `get_zone_eligible_ad_groups` — vanished on any large zone, with no way to request a narrower slice | `9acb778` |
| 2 | `complete` was offset-relative | A tail page holding 37 of 207 rows reported `complete: true`; a consumer reconciling against the exact `summary` would file it as a regression | `917c5df` |
| 3 | `next_offset` did not advance past a row too large to serialize | **Non-terminating walk.** A single 232KB row (`ducqqp`) made `next_offset == offset`, so every row after it was unreachable. Blocked the whole-network sweep | `e357328` |
| 4 | Dotted `fields` paths matched nothing, silently | Rows came back looking clean with the requested data absent, and pages could not be shrunk below the parent object — on the exact collection holding the 232KB row | `ad09fb1` |
| 5 | `fitEntityToText` elided only string leaves | An entity whose bulk is 20k *short* strings could not be shrunk at all; `get_ad_group("ducqqp")` returned no data whatsoever | `ad09fb1` |
| 6 | `unknown_fields` judged per-page | A sparse-but-real field absent from one page would falsely read as "wrong path" mid-sweep | `092de78` |
| 7 | `fields` description still said "no row **on the page**" after fix 6 | The description is what an agent reads, so a stale one is a live defect: it made a sound one-call-per-network probe look unsound and stopped a cross-network pass | `bd6f5d4` |
| 8 | An EMPTY collection flagged every requested field | Network `6s31vy` (0 ads) flagged both `params.zoneId` and `adGroupId` — vacuously true, and reads as "your paths are wrong" when the truth is "there are no rows" | `4ccf76f` |

**Behavioural changes introduced by the fixes:**

- `get_zone_eligible_ad_groups` gained `bucket` (`all` \| `directlyTargeted` \| `freeRadicals` \| `conflicting`) and `offset`, and returns `page: { bucket, offset, returned, total, next_offset? }` plus `complete`.
- `truncated` became `complete: false` in the zone-composite family. The `list_*` family deliberately keeps `truncated` / `has_more` / `next_offset` — it has a cursor to continue with, which the composites don't.
- `fields` accepts dotted paths, projecting the leaf under its dotted key (`{"params.zoneId": [...]}`).
- Envelopes carry `unknown_fields` when a requested path matches no row in the collection.
- Oversize list rows return an `{ id, _omitted }` stub with `truncated.skipped_oversized`, and `next_offset` advances past them.
- Oversize entities shed large arrays as a unit (`[elided: N items, M chars]`), leaving every other field intact.

---

## Assertion corrections

Two assertions from the original set are worded such that they will fail on correct behaviour. Both are pinned by unit tests in their corrected form.

**E1 — symmetry is over the eligible set, not response membership.**
As written: `reach(X) ∋ Z ⟺ eligible(Z) ∋ X`. But `adGroupReach` filters to `eligible: true`, while `zoneEligibility` deliberately **retains** whitelisted-but-ineligible groups in `directlyTargeted[]` so config breakage surfaces instead of vanishing. A whitelisted CAG-mismatched group therefore appears in the bucket listing and not in `reach()`. Verified live on `zw73wl` (`eligible: false`, `reasons: ["archived"]`, `reach()` returns zero zones). The retention is what E5 and B5 depend on — do not "fix" the code to match the wording.

**A1 — assert per-bucket set equality, not the sum.**
As written: `directlyTargeted + conflicting == inventory groups[]`. Both tools bucket a targets-and-excepts group the *same* way, so such a group is in **neither** tool's targeted set — the inventory reports it under its own `conflicting[]`, separate from `groups[]`. The identity as written therefore holds **only while `conflicting` is 0**, which is the only case production data can currently produce. The honest invariant is: `eligibility.directlyTargeted` set == `inventory.targeted` set, `eligibility.conflicting` set == `inventory.conflicting` set, and the two buckets are disjoint. Pinned in `src/tests/eligibility.test.ts` ("A1 — the two tools agree bucket-for-bucket when conflicting is non-empty").

---

## Pass 0 — Paging contract smoke test (zone `6wahzt`)

### Prompt

> Use the Lincx tools. Switch to network 7jdz0n, then call get_zone_eligible_ad_groups on zone 6wahzt with no other arguments. Report, from the raw JSON only: 1. Does the response contain a "page" object? List its keys and values. 2. Does it contain "complete"? What value? 3. Does any row contain "truncated"? (Expected: no — the flag was renamed.) 4. Quote one full row verbatim, all fields. Do not summarize or interpret. If "page" is absent, stop and say the deployed build predates the paging change.

### Response

**1. `page` object — present.**

```json
"page":{"bucket":"all","offset":0,"returned":11,"total":11}
```

No `next_offset` key is present.

**2. `complete` — present, value `true`.**

**3. `truncated` — no.** The string does not appear anywhere in the response.

**4. One full row verbatim** (first entry of `directlyTargeted`):

```json
{"id":"c70deo","name":"QL Listicle | SmartSeniorSavings Header","archived":false,"campaign_on":true,"adgroup_on":true,"has_enabled_ad":true,"creative_resolves":true,"has_live_viable_ad":true,"fully_live":true,"off_reason":[],"scoped_via":["ad-group-whitelist","zone-selection"],"eligible":true,"via":["ad-group-whitelist","zone-selection"],"reasons":[],"conflicts":[],"offers":{"total":1,"serving":1,"freeRadical":0,"adLevelTargeted":0,"adLevelBlacklisted":0,"confinedElsewhere":0,"freeRadicalAdIds":[]}}
```

---

## Pass A — Inventory ↔ eligibility reconciliation (zone `8z7wzb`)

### Prompt

> Network 7jdz0n. Call get_zone_targeting_inventory(zoneId="8z7wzb", mode="all"), then get_zone_eligible_ad_groups(zoneId="8z7wzb", bucket="directlyTargeted") and page with offset until page.next_offset is absent. Then the same for bucket="conflicting".
> A1: len(directlyTargeted across all pages) + len(conflicting) vs the inventory groups[] count. Equal?
> A2: The two id SETS — are they identical? List any id in one and not the other.
> A3: For 5 ids sampled from both tools, compare campaign_on, adgroup_on, has_live_viable_ad, fully_live, off_reason[]. Any field differing? Quote both rows.

### Response

| | value |
|---|---|
| inventory `summary.targeted` | 83 |
| inventory `groups[]` rows returned | 83 |
| inventory `conflicting[]` rows | 0 |
| eligible p1 `page` | `{bucket:"directlyTargeted",offset:0,returned:47,total:83,next_offset:47}` |
| eligible p2 `page` | `{bucket:"directlyTargeted",offset:47,returned:36,total:83}` (no `next_offset`) |
| directlyTargeted rows across pages | 47 + 36 = 83 |
| conflicting call `page` | `{bucket:"conflicting",offset:0,returned:0,total:0}`, `complete:true` |
| eligible `summary` directlyTargeted / Live / Ineligible | 83 / 11 / 42 |
| inventory `summary` live / off / archived | 11 / 72 / 42 |

**A1 — Equal.** 83 + 0 = 83.
**A2 — Identical sets**, and the ids came back in the same order in both tools.
**A3 — No field differed** on any of the 5 sampled ids (`hsd4bf`, `v35qo6`, `gp07d5`, `z5869e`, `ol5pa1`).

Sample pair, `v35qo6` — inventory:

```json
{"id":"v35qo6","name":"ADNET - NEW AMERICAN FUNDING - HELOC","archived":false,"campaign_on":false,"adgroup_on":false,"has_enabled_ad":false,"creative_resolves":true,"has_live_viable_ad":false,"fully_live":false,"off_reason":["campaign","adgroup","no_live_viable_ad"],"scoped_via":["ad-group-whitelist","zone-selection"]}
```

eligible (p1): identical on all compared fields, plus `"eligible":true,"via":["ad-group-whitelist","zone-selection"],"reasons":[],"conflicts":[],"offers":{...}`.

All 42 `directlyTargetedIneligible` rows carry `reasons: ["archived"]`, matching the inventory's 42 archived.

> **Caveat carried forward:** this run has `conflicting: 0`, so A1 tested only one term. See the A1 correction above; the two-term case is covered by unit test only.

---

## Pass B — Multi-page integrity and cross-bucket continuity (zone `8z7wzb`)

### Prompt

> Network 7jdz0n, zone 8z7wzb. Call get_zone_eligible_ad_groups(zoneId="8z7wzb", bucket="freeRadicals"), then keep calling with offset=&lt;next_offset&gt; until absent. B5a: is each row a full JSON object or a bare id string? B5b: Σ page.returned vs page.total. B5c: distinct ids vs summary.freeRadicalGroups. B5d: duplicates or gaps? B5e: is summary identical on each page? B5f: complete — true on any page? Then repeat with bucket="all".

### Response

#### freeRadicals — pages recorded

| page | offset | returned | total | next_offset | complete |
|---|---|---|---|---|---|
| 1 | 0 | 52 | 124 | 52 | false |
| 2 | 52 | 52 | 124 | 104 | false |
| 3 | 104 | 20 | 124 | *(absent)* | false |

**B5a — Every row on every page is a full JSON object.** No bare id strings. All of `offers`, `scoped_via`, `via`, `reasons`, `conflicts` present on every row. First row of page 1:

```json
{"id":"sheqrx","name":"Rate Select - mortgage-refinance [Exchange]","archived":false,"campaign_on":true,"adgroup_on":true,"has_enabled_ad":true,"creative_resolves":true,"has_live_viable_ad":true,"fully_live":true,"off_reason":[],"scoped_via":["zone-selection"],"eligible":true,"via":["zone-selection"],"reasons":[],"conflicts":[],"offers":{"total":1,"serving":1,"freeRadical":1,"adLevelTargeted":0,"adLevelBlacklisted":0,"confinedElsewhere":0,"freeRadicalAdIds":["tz9475"]}}
```

**B5b — Equal.** 52 + 52 + 20 = 124.
**B5c — Equal.** 124 distinct ids = `summary.freeRadicalGroups`.
**B5d — No duplicates, no gaps.** Ranges contiguous (0–51, 52–103, 104–123); seams independently confirmed by the `all` run.
**B5e — Identical on all pages** and across bucket runs: `{directlyTargeted:83, directlyTargetedLive:11, directlyTargetedIneligible:42, freeRadicalGroups:124, freeRadicalGroupsLive:80, freeRadicalOffers:217, adLevelTargetedOffers:0, adLevelBlacklistedOffers:2, conflicting:0}`.
**B5f — `complete` true on no page.** Correct per the absolute definition.

#### bucket="all" — paging continuous across buckets

| page | offset | returned | next_offset | rows |
|---|---|---|---|---|
| 1 | 0 | 47 | 47 | DT[0–46] |
| 2 | 47 | 48 | 95 | DT[47–82], then FR[0–11] |
| 3 | 95 | 52 | 147 | FR[12–63] |
| 4 | 147 | 52 | 199 | FR[64–115] |
| 5 | 199 | 8 | *(absent)* | FR[116–123] |

Sum 47+48+52+52+8 = 207 = 83 + 124 + 0. Offset is global: page 2 spans the DT→FR boundary in one response (`ol5pa1` immediately followed by `sheqrx`) with no row repeated or skipped.

One transport error (`Error: terminated`) occurred on `bucket:"all", offset:47`; an identical retry succeeded, no data lost. Pages are packed close to `RESPONSE_SIZE_LIMIT`, so if this recurs the mitigation is to reserve headroom below the limit.

---

## Pass C — `scoped_via` enum conformance

### Prompt

> Collect every distinct scoped_via value emitted by get_zone_targeting_inventory(8z7wzb, all), get_zone_eligible_ad_groups(8z7wzb, bucket="all") all pages, and explain_serve(6wahzt, adId=&lt;ad under dr0xp2&gt;). C3 passes only if every value is one of exactly: ad-group-whitelist, ad-group-blacklist, ad-level-whitelist, ad-level-blacklist, zone-selection. Note separately: "via" is a different, narrower field.

### Response

**C3: PASS.** Every value in all three lists is within the five-value enum.

1. **`get_zone_targeting_inventory`** — `ad-group-whitelist`, `zone-selection`. Every row carried exactly `["ad-group-whitelist","zone-selection"]`.
2. **`get_zone_eligible_ad_groups`** (207 rows) — `ad-group-whitelist`, `ad-level-blacklist`, `zone-selection`. `ad-level-blacklist` came from exactly two free-radical rows, `yq4z1t` and `4leo31`.
3. **`explain_serve(6wahzt, adId="jzhvyr")`** — `zone-selection`, at `offer.scoped_via`.

**Coverage:** 3 of 5 values exercised. `ad-group-blacklist` and `ad-level-whitelist` were never emitted — now known to be **structurally absent from the network** (passes H and I), not merely unobserved. C3 confirms nothing outside the enum is emitted.

**`via` (kept separate):** `ad-group-whitelist` and `zone-selection` only — 2 values, as designed.

---

## Pass D — Offer-grain arithmetic

### Prompt

> Network 7jdz0n, zone 8z7wzb, bucket="freeRadicals", all pages. D1: Σ row.offers.freeRadical vs summary.freeRadicalOffers. D2: per row, freeRadical + adLevelTargeted + adLevelBlacklisted + confinedElsewhere ≤ total? D4: len(offers.freeRadicalAdIds) == offers.freeRadical? D5: sample 3 freeRadicalAdIds via get_ad — params.zoneId empty, 8z7wzb absent from exceptParams.zoneId?

### Response

**D1 — Equal.** 89 + 95 + 33 = **217** = `summary.freeRadicalOffers`.

**D2 — No violations.** 122 of 124 rows have `freeRadical == total`. The two others:

- `yq4z1t`: 0 + 0 + 1 + 0 = 1 ≤ total 1
- `4leo31`: 1 + 0 + 1 + 0 = 2 ≤ total 2

**D4 — No violations** on all 124 rows, including the two edge rows.

**D5 —** Sampled `tz9475`, `icbib4`, `gnhfjj`. All three: `params` is `{}`, and `8z7wzb` is absent from `exceptParams.zoneId`:

```json
"params":{}
"exceptParams":{"zoneId":["wybc5x","n16fj4","yzhp5o","mm9dei","925nzt"]}
```

---

## Pass E — Reach, explain_serve, and eligible-set membership

### Prompt

> E1: pick 5 eligible ad groups from get_zone_eligible_ad_groups(6wahzt); confirm 6wahzt is in each reach(). Then confirm an eligible:false row is ABSENT from reach(). E2: explain_serve agreement for 3 ids. E3: reach(dr0xp2) — every zone whose CAG is fab2jc? E4: explain_serve(zone, adId) offer.freeRadical for an id in / not in freeRadicalAdIds. E5: does every eligible:false row carry non-empty reasons[] or conflicts[]?

### Response

Zone `6wahzt` has **no `eligible: false` rows** — all 11 are eligible, `summary.directlyTargetedIneligible` is 0. Negative halves substituted from `8z7wzb` and labelled.

**E1 — All 5 confirmed.**

| group | bucket | reaches | via[] for 6wahzt |
|---|---|---|---|
| c70deo | directlyTargeted | 6 | `ad-group-whitelist, zone-selection` |
| fx40b5 | directlyTargeted | 6 | `ad-group-whitelist, zone-selection` |
| 9uhou0 | directlyTargeted | 6 | `ad-group-whitelist, zone-selection` |
| dr0xp2 | freeRadicals | 6 | `zone-selection` |
| l3do8b | freeRadicals | 6 | `zone-selection` |

Asymmetry (from `8z7wzb`): `zw73wl` is `eligible: false`, `reasons: ["archived"]`, present in `directlyTargeted[]`; `reach(zw73wl)` returns `zones: []`. Intended — see the E1 correction.

**E2 — All 3 match** (`c70deo`, `dr0xp2`, `l3do8b`), including `via[]`.

**E3 — Yes, exactly.** `reach(dr0xp2)` = `6wahzt`, `ehexuv`, `q2f499`, `9e7zny`, `8q0dx7`, `qt3mjh`. Cross-checked against a full `list_zones` walk (4 pages, 359 zones): exactly six zones carry `creativeAssetGroupId: fab2jc`, the same six, all unarchived.

**E4 — Positive confirmed.** `explain_serve(6wahzt, adId="jzhvyr")` → `offer: {scoped_via: ["zone-selection"], freeRadical: true}`. Negative not available in that group (`dr0xp2` has exactly one ad). Nearest available, `4leo31` in `8z7wzb`, sibling ad `pxdj47`:

```json
"offer":{"scoped_via":["ad-level-blacklist","zone-selection"],"freeRadical":false}
```

with `eligible: false`, `reasons: ["ad-blacklisted"]`. So `freeRadical: false` holds, but via the *blacklist* branch. The whitelist branch remains structurally absent (pass I).

**E5 — In `8z7wzb`, all 42 `eligible: false` rows carry `reasons: ["archived"]`;** `conflicts` is `[]` on every one, consistent with `conflicting: 0`. `reasons[]` exercised, `conflicts[]` confirmed absent network-wide by pass H.

---

## Pass F — Free-radical host config shape and `adFeedCount`

### Prompt

> For 3 free-radical hosts from get_zone_eligible_ad_groups(6wahzt, bucket="freeRadicals") — including dr0xp2 — call get_ad_group. F1: params.zoneId empty/absent, exceptParams.zoneId empty/absent, creativeAssetGroupId == fab2jc? F3: report get_zone("6wahzt").adFeedCount separately and state it is a serving selection, not an eligibility count.

### Response

**F1 — All three pass.** `dr0xp2`, `l3do8b`, `wjaoux` each returned:

```json
"params":{}
"exceptParams":{}
"creativeAssetGroupId":"fab2jc"
```

No `zoneId` key at either position — no whitelist, no blacklist, in scope purely by shared CAG, which is why each reaches all six `fab2jc` zones.

**F3 — `adFeedCount` = 10.** One rotation's selection size — a serving parameter, not an eligibility figure. Not compared against `directlyTargeted` (7), `freeRadicalGroups` (4), `freeRadicalOffers` (4), or the 11-row eligible set. `forcedAdGroups` additionally pins `c70deo` to position 0 and `fx40b5` to position 1; likewise not an eligibility count.

---

## Pass G — Defect-fix smoke test (2026-08-04)

### Prompt

> Network 7jdz0n. Four calls, report each verbatim, no manual offset advancement, no reasoning from earlier sessions.
> 1. list_ad_groups(limit=100, offset=1, fields=["params"]) — next_offset, and whether items[0] has "_omitted".
> 2. list_ad_groups(limit=5, offset=0, fields=["params.zoneId","exceptParams.zoneId"]) — do the dotted keys appear? Is the parent "params" absent?
> 3. list_ad_groups(limit=5, offset=0, fields=["nonsense.path"]) — does the envelope contain unknown_fields?
> 4. get_ad_group("ducqqp") — id, name, creativeAssetGroupId, exceptParams, and what params.zoneId now contains.

### Response

**All four behave as expected.**

**1 — the stall is fixed.**

```json
{"items":[{"id":"ducqqp","_omitted":"This row alone exceeds the response budget; fetch it with get_<entity> or a narrower 'fields'."}],"total":1150,"limit":100,"offset":1,"has_more":true,"next_offset":2,"truncated":{"returned":0,"fetched":100,"skipped_oversized":"ducqqp","reason":"One row exceeds the 25000-char budget on its own, so no full item fit. Its id is returned as a stub and next_offset advances past it — request offset=2 to continue, or pass a narrower 'fields'."}}
```

`next_offset` = 2 — advances. Stub present, `skipped_oversized` names `ducqqp`.

**2 — dotted paths project the leaf, flat.**

```json
{"id":"68fq1s","name":"Billshark - Exchange - No Match","enabled":true,"archived":true,"params.zoneId":["mkh23a"],"exceptParams.zoneId":["ddbbai"]}
```

The parent `params` object is absent; rows lacking `exceptParams.zoneId` omit the key rather than emitting it empty. `ducqqp` returns normally under this projection — the oversized array isn't selected.

**3 — `unknown_fields` present**, value `["nonsense.path"]`, with rows falling back to default fields. The silent-failure mode is gone.

**4 — `get_ad_group("ducqqp")` now succeeds** where it previously failed outright at 232,813 bytes:

```json
"params":{"zoneId":["mkh23a"],"zip":"[elided: 8931 items, 71449 chars]"}
"_truncated":{"elided":["data.params.zip"],"reason":"Response exceeded 25000 chars; the largest string and array fields were elided (the rest of the entity is intact)..."}
```

| field | value |
|---|---|
| id | ducqqp |
| name | EasyKnock - click_to_post_direct [Exchange] |
| creativeAssetGroupId | 0bckt2 |
| exceptParams | `{"mortgageBalance":["95000","90000","85000","80000","75000","70000","0"]}` |
| params.zoneId | `["mkh23a"]` — intact, not elided |

The bloat is `params.zip` (8,931 ZIP codes), not `zoneId`. Elision picked the right leaf; `zoneId`, `geo`, `clickLimit`, `exceptParams` and all identifiers survive.

---

## Pass H — Exhaustive ad-group sweep for targets-and-excepts (2026-08-04)

### Prompt

> Network 7jdz0n. Call list_ad_groups with limit=100, offset=0, fields=["params.zoneId","exceptParams.zoneId"]. Page with next_offset until absent — 12 pages, 1150 groups. If any item comes back with "_omitted", record its id and keep paging. If the envelope reports unknown_fields, stop and report it. Report every group where "params.zoneId" and "exceptParams.zoneId" share at least one zone id — the intersection, not a substring match. Ignore "zoneId-position" keys entirely.

### Response

**Sweep complete — all 12 pages, 1,150 of 1,150 groups.**

| pages | offset | returned | next_offset |
|---|---|---|---|
| 1–11 | 0, 100, … 1000 | 100 each | advances by 100 |
| 12 | 1100 | 50 | `null`, `has_more: false` |

11 × 100 + 50 = 1,150 = total. **No `_omitted` items on any page** — under this narrow projection even `ducqqp` and `8a4cew` return normally. **No `unknown_fields` on any page**, so the paths resolved and the sweep is meaningful.

**Result: the table is empty.** No ad group in `7jdz0n` has any zone id appearing in both `params.zoneId` and `exceptParams.zoneId`. Zero rows, across all 1,150 groups.

About 70 groups carry both keys populated, and every pair is disjoint. The reason is structural: `exceptParams.zoneId` is essentially always one of a few boilerplate blocklists —

- `["ddbbai"]`
- `["bkhbx3","nh36qj","ddbbai","4u7g94"]`
- `["wybc5x","n16fj4","925nzt"]` (and the 7-element union of the two above)
- `["8z7wzb","em2k3p","ddbbai"]` / `["em2k3p","ddbbai"]`

— applied to groups whose whitelists don't name those zones. It reads like an exclusion template pasted onto Exchange groups, not per-group tuning that could collide with targeting.

Closest near-miss: five groups whitelist `ddbbai` in `params.zoneId` — `ow6ets`, `ple7fj`, `quc2qz`, `t8fngw`, `9l1inq` — the same zone that dominates every blocklist. None of the five carries an `exceptParams.zoneId` key, so there is still no intersection.

Three groups use a **different key**, `zoneId-position`, excluding a zone at a specific slot: `ggg7ww` (`em2k3p-1`), `hu4gni` (`8z7wzb-2`, `8z7wzb-1`), `qc3a2v` (`em2k3p-1`). Different key, different semantics — excluded from this check per instruction, and flagged as an open question.

**Consequence:** the conflicting-bucket check is **CONFIRMED ABSENT**, not blocked — established by exhaustive sweep rather than inference. `conflicts[]` containing `targets-and-excepts` and `scoped_via` containing `ad-group-blacklist` are unreachable on this network's data.

---

## Pass I — Exhaustive ad sweep for ad-level zone whitelists (2026-08-04)

### Prompt

> Network 7jdz0n. Call list_ads with limit=100, offset=0, fields=["params.zoneId","adGroupId"]. Page with next_offset until absent (~14 pages). If any envelope reports unknown_fields, stop and report it. Report every ad whose "params.zoneId" is a non-empty array. Then for each distinct adGroupId, get_ad_group and keep only groups whose params.zoneId is empty or absent — those are D3 fixtures.

### Response

**Result reached two independent ways, both agreeing.**

**Method 1 — dotted projection, one call.**

```json
"total":1331,"limit":100,"offset":0,"has_more":true,"next_offset":100,"unknown_fields":["params.zoneId"]
```

`unknown_fields` reports that `params.zoneId` matched **no row in the collection**. `adGroupId` resolved normally in the same response, so projection ran correctly — this is the flag doing its job, not an endpoint limitation. (`list_ads` and `list_ad_groups` call identical code: `listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }))`. There is no per-endpoint field handling. And `unknown_fields` shipped in the same commit as dotted paths, so its presence proves the current build is live on this endpoint.)

**Method 2 — full 14-page walk with `fields=["params","adGroupId"]`.** All 1,331 ads. **Zero ads with a non-empty `params.zoneId`.** The only ad-level param keys in use network-wide are `trafficType`, `scriptVersion`, `dateTimeVisitor`, and `age`.

**Result: no ad-level zone whitelist exists anywhere in `7jdz0n`.** Therefore no untargeted group holding a zone-whitelisted ad, therefore no D3 fixture, therefore nothing to look up in `freeRadicals[]`.

Key naming is confirmed correct, not a schema mismatch: ads **do** use `exceptParams.zoneId` — that is the source of `8z7wzb`'s `adLevelBlacklistedOffers: 2` (`yq4z1t`, `4leo31`). Ad-level blacklists are in use; ad-level whitelists simply are not.

**D3 status: CONFIRMED ABSENT** (was UNEXERCISED). The `ad-level-whitelist` branch through the offer-grain counters cannot be exercised on production data. Required fixture: an ad group with empty `params.zoneId` on the target zone's CAG, holding ≥1 ad with empty `params` **and** ≥1 ad whose `params.zoneId` names that zone. Both ads are needed — a group whose only ad is zone-whitelisted is precisely the case D3 exists to pin.

---

## Pass J — Cross-network probe for ad-level zone whitelists (2026-08-04)

### Prompt

> For each network id, call network_switch, then ONE call: list_ads(limit=100, offset=0, fields=["params.zoneId","adGroupId"]). Report per network whether the envelope contains unknown_fields. unknown_fields containing "params.zoneId" means NO ad in that entire network has an ad-level zone whitelist — the path is judged against the whole collection, not the page.

### Response

The reviewer initially **refused the inference rule**, correctly, on the basis of the tool description ("matched no row on the page"). The description was stale — defect 7 above. The scope was then established empirically before the pass ran:

> `list_ads(limit=1, offset=0, fields=["params.age"])` on `7jdz0n` → `items[0]` (`0gat04`) has no `params.age` key, and the envelope has **no** `unknown_fields`. Under page scope with `limit=1` the flag would have fired. It didn't, so the check ran against rows beyond the one returned. **Collection scope confirmed.**

Corroborated three further ways: Adnet (path populated on real rows, no flag), **Speedwell (no flag despite zero of its first 100 rows carrying the path — the exact false negative page-scoping would have produced)**, and Core Digital (flag agreeing with the independent 14-page walk of pass I).

**25 of 63 networks probed** before hitting a tool-use limit. Six carry ad-level zone whitelists:

| id | name | ads | D3 candidate |
|---|---|---|---|
| cn850c | Speedwell | 255 | yes |
| xvret6 | Adnet | 488 | yes |
| h9ue34 | Interlincx | 389 | yes |
| 76ijr3 | Dawit Net | 101 | yes |
| ny8afd | SCRMP Demo | 1,578 | yes |
| 3i9kgt | Demo World | 131 | yes |

Networks flagged (no ad-level whitelist anywhere): `7jdz0n` Core Digital (1,331), `rwz914` Path (3,365), `vb2s46` ThinkHow (704), `ria673` RXMG (431), `8ahqk7` Utterance (280), `vgo6qb` Lincx (212), `fb5o38` Leadpoint (203), `4c63we` Lido Labs (179), `336xd5` ZAKA Network (139), `3i9kgt`-adjacent smaller entries.

`6s31vy` (Lincx Sandbox) flagged vacuously — 0 ads, so every requested field including `adGroupId` came back unknown. Excluded from the negative set, and fixed as defect 8.

**Remaining 38 networks unprobed:** `ig9gwx`, `l9bwct`, `sg88pb`, `rm77jb`, `mwdzlx`, `h6bb3t`, `lbdfjl`, `6b3bky`, `qr52au`, `3nfsow`, `erc1f0`, `sn9t2j`, `hb4iu1`, `1aabor`, `1y9pi3`, `gd5ceo`, `hnd4k1`, `2hhnnd`, `hx2xnf`, `ds0ogj`, `b511b0`, `n3deex`, `1e4n8s`, `8z8znz`, `fvddkg`, `t68i9u`, `udbcld`, `9dbswj`, `301ylr`, `7u55hm`, `jtc0ga` (Adnet v2), `z4fe6c`, `u5dr9f`, `qofva4`, `5d31zn`, `rj9ow1`, `c09k5z`, `3ih01i`.

---

## Pass K — Adnet: `ad-level-whitelist` exercised live (2026-08-04)

### Prompt

> Network xvret6 (Adnet). Zone upd39v. 1. get_zone_targeting_inventory(zoneId="upd39v", mode="all") — report scoped_via[] for 1oby5f, x26b1q, p3a87b. 2. get_zone_eligible_ad_groups(zoneId="upd39v", bucket="directlyTargeted") — report those rows' offers and summary.adLevelTargetedOffers. Also report the zone's creativeAssetGroupId.

### Response

Zone `upd39v` — "USA - Consumer | Senior Listicle - Facebook", CAG `6j5glr` (matches), template `ka33ym`. Both calls returned `complete: true` (18 of 18 rows).

**Step 1 — `scoped_via`**

| group | scoped_via[] |
|---|---|
| 1oby5f | `ad-group-whitelist`, `ad-level-whitelist`, `ad-level-blacklist`, `zone-selection` |
| x26b1q | `ad-group-whitelist`, `ad-level-whitelist`, `ad-level-blacklist`, `zone-selection` |
| p3a87b | **no row — absent from the inventory** |

**Step 2 — offers**

| group | total | serving | freeRadical | adLevelTargeted | adLevelBlacklisted |
|---|---|---|---|---|---|
| 1oby5f | 2 | 1 | 0 | 1 | 1 |
| x26b1q | 3 | 1 | 0 | 1 | 2 |

`summary.adLevelTargetedOffers`: **23** (0 on every Core Digital zone). `adLevelBlacklistedOffers`: 28. `freeRadicalGroups`: 0, `freeRadicalOffers`: 0, `directlyTargetedIneligible`: 0, `conflicting`: 0.

**C3 goes from 3 of 5 to 4 of 5 values exercised live.** Only `ad-group-blacklist` remains unreachable on production data.

**`p3a87b` confirms the serving order from the outside.** Its ad `vk5xdn` whitelists `upd39v`, but the group targets six zones not including `upd39v`. It is absent from both tools for this zone — `filterAdgroups()` runs first, so an ad-level whitelist under an out-of-scope group is inert. This is the ordering the join encodes, observed live rather than inferred.

### Full Adnet ad sweep — D3 result

All 5 pages, 488 ads, `has_more: false`. **59 ads carry a non-empty `params.zoneId`, across 25 distinct ad groups. Every one of the 25 groups is itself directly targeted — zero D3 fixtures.** No group archived.

Ad-level whitelists appear in exactly two forms, neither of which is D3:

- **Narrowing** (17 groups, 41 ads): the ad's zones are a subset of its group's — an ad confined to part of the scope the group already covers. Mostly the `| fbz` variant pinned to `upd39v`, `hh4x9w`.
- **Escapes** (8 groups, 18 ads): the ad whitelists a zone its group's whitelist does **not** contain. Inert by the ordering above — the whitelist never fires.

| group | escaping ads → zone not in group's whitelist |
|---|---|
| p3a87b Roofing | `vk5xdn`, `2j5j7q`, `ff14qx`, `6nd27i` → `upd39v` |
| lbbotg Windows | `ra3e9r`, `eehbcw`, `b03r52`, `os5njy` → `upd39v` |
| qgd68r HELOC | `1s65at`, `sg1rot`, `dg9i7d` → `upd39v` |
| ff26gi Auto Insurance | `pie2dt`, `w75qzu` → `upd39v` |
| xidh3h USA Consumer Listicle | `aif92g` → `hh4x9w`; `d045k4` → `zk8hmm` |
| 4qe1qw Timeshare Exit | `oaauma` → `upd39v` |
| 48exva Solar Exit | `i080uq` → `upd39v` |
| vc6nqy SunValue Section B | `db0fu3` → `lx84p7` (ad archived) |

**This is an operational finding, not a tooling defect** — see open item 7. Six live groups have Facebook-zone targeting that silently does nothing.

**D3 status across two networks:** Core Digital has no ad-level whitelists at all (1,331 ads); Adnet has the richest usage of the 25 networks probed and still yields zero D3 fixtures (25 groups). The precise claim the data supports is narrower than "all narrowing": **ad-level whitelists were observed only under groups that already carry one, in two forms — narrowing within group scope, and inert escapes outside it. The untargeted-group shape D3 depends on was not observed.** The group-grain over-count Rex identified is a real semantic bug that production config does not currently trigger.

---

## Appendix — reference figures

### Zone `8z7wzb` — Quicken Loans Refinance – Match (CAG `0bckt2`)

| metric | value |
|---|---|
| directlyTargeted | 83 |
| directlyTargetedLive | 11 |
| directlyTargetedIneligible (all archived) | 42 |
| freeRadicalGroups | 124 |
| freeRadicalGroupsLive | 80 |
| freeRadicalOffers | 217 |
| adLevelTargetedOffers | 0 |
| adLevelBlacklistedOffers | 2 |
| conflicting | 0 |
| total rows, `bucket:"all"` | 207 |

### Zone `6wahzt` — Quicken Loans – Listicle – SmartSeniorSavings (CAG `fab2jc`)

| metric | value |
|---|---|
| directlyTargeted | 7 |
| directlyTargetedLive | 7 |
| directlyTargetedIneligible | 0 |
| freeRadicalGroups | 4 |
| freeRadicalGroupsLive | 0 |
| freeRadicalOffers | 4 |
| adLevelTargetedOffers | 0 |
| adLevelBlacklistedOffers | 0 |
| conflicting | 0 |
| total rows, `bucket:"all"` | 11 |
| adFeedCount (serving parameter) | 10 |

### Network-wide sweep totals

| collection | rows swept | result |
|---|---|---|
| ad groups | 1,150 of 1,150 | 0 targets-and-excepts |
| ads | 1,331 of 1,331 | 0 ad-level zone whitelists |
| zones | 359 of 359 | 6 share CAG `fab2jc` |

### Zones sharing CAG `fab2jc`

`6wahzt`, `ehexuv`, `q2f499`, `9e7zny`, `8q0dx7`, `qt3mjh` — six zones, all unarchived. Any untargeted ad group on this CAG reaches all six.

### Scan scope reported by the server on every eligibility call

`zonesScanned: 359`, `adGroupsScanned: 1150`, `campaignsScanned: 664`, `adsScanned: 1331`, `creativesScanned: 1344`.

### Ad-level param keys in use network-wide

`trafficType`, `scriptVersion`, `dateTimeVisitor`, `age`. Notably **not** `zoneId`.

### Repo-side coverage for the two absent branches

| branch | test |
|---|---|
| `ad-level-whitelist` / D3 host row | `src/tests/eligibility.test.ts` — "D3 — the host row survives, the offer count does not" |
| `ad-group-blacklist` emission | `src/tests/eligibility.test.ts` — "C3 — shared scoped_via domain" |
| `conflicts[]` / targets-and-excepts | `src/tests/eligibility.test.ts` — "targets-and-excepts goes to conflicting, not directlyTargeted" |
| A1 with `conflicting` non-empty | `src/tests/eligibility.test.ts` — "A1 — the two tools agree bucket-for-bucket when conflicting is non-empty" |
| E1 asymmetry | `src/tests/eligibility.test.ts` — "E1 — symmetry holds on eligibility, not on response membership" |
| Paging / full-row integrity (B5) | `src/tests/eligibilityFit.test.ts` — 12 cases at the 83 + 124 fixture scale |
| `next_offset` stall | `src/tests/listEnvelope.test.ts` — "a single row bigger than the whole budget" |
| Dotted paths + `unknown_fields` | `src/tests/listEnvelope.test.ts` — "dotted field paths" |
| Array elision on entities | `src/tests/fitEntity.test.ts` — "elides a huge array of small strings" |

Full suite: 185 tests, all passing as of commit `092de78`.
