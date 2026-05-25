# lincx-mcp-server — Norms & Token-Consumption Audit

Audit date: 2026-05-25 (rev 2 — refocused on connection-only scope).
SDK: `@modelcontextprotocol/sdk@^1.12.0` (stale — see T1-1).
Surface today: **35 registered tools** (down from 43), 0 resources, 0 prompts,
1 tool using `structuredContent` (`auth_status`), 0 tools with `outputSchema`.

Checklist is ordered by token impact, not by file. The leanest possible surface
is also the cheapest per request — so the scope cut in **Tier 0** is both a design
decision and the biggest remaining token win.

---

## Guiding principle — the MCP is a Lincx *connection*, nothing more

The MCP server's only job is to **authenticate, hold network context, and expose
Lincx Work API data** as thin, predictable tools. It must NOT do orchestration,
rendering, mock-data synthesis, multi-call fan-out, or local file bundling.

Those actions move to a **companion plugin (Claude Code skills + scripts)** that
consumes the lean MCP tools. Rationale:
- **Token cost** — composite tools carry the largest schemas (paid every request)
  and emit the largest payloads (full HTML/CSS, fan-out blobs).
- **Separation of concerns** — render/preview/trace logic changes often and is
  client-side workflow; it doesn't belong behind an auth boundary.
- **Testability** — scripts are easier to iterate on than tools wedged into the
  request path.

**Belongs in the MCP:** `auth_*`, `network_*`, every `list_*` / `get_*` (incl.
`include:['parents']`), `get_zone_report`, `get_zone_ads`, the reporting/dimension
tools. Thin wrappers over a single Work API endpoint.

**Does NOT belong (move out):** `render_template`, `get_template_preview_bundle`,
`zone_load_trace`, and the `generateMockAds` helper.

**Deliberate exception:** `report_query`'s server-side aggregation stays. It is
not orchestration — it's response-size management for a single high-row endpoint
(the alternative is dumping thousands of hourly rows into context). It exposes
`raw: true` for any skill that wants the unaggregated rows. See T3-3.

---

## Tier 0 — Scope: move orchestration out of the MCP (do FIRST)

This supersedes the old "tier the surface" item (was T1-6). Removal beats gating.

- [ ] **T0-1 — Remove `render_template` + `get_template_preview_bundle`** from `templateTools.ts`, and delete the `generateMockAds` helper. These fetch a template + CAG, synthesize mock ads, and bundle HTML/CSS — pure client workflow. Net: −2 tools, −2 of the largest schemas, and the biggest single-payload offenders gone from the request path.
- [ ] **T0-2 — Remove `zone_load_trace`** from `zoneTools.ts`. Its multi-round fan-out (zone + parents + ad-serving + debug + per-ad details + template) is exactly the orchestration a skill should own. Net: −1 tool, −1 large schema.
- [ ] **T0-3 — Expose the one endpoint the trace skill would otherwise lose.** `/api/ads/ad/debug` is currently reached *only* inside `zone_load_trace`. Before deleting it, add a thin accessor so the skill can still get debug data — simplest: add a `debug: boolean` flag to `get_zone_ads` (`GET /api/ads/ad` vs `/api/ads/ad/debug`). This is the only new MCP capability the cut requires; everything else the skills need (`get_template`, `get_creative_asset_group`, `get_zone` with parents, `get_ad`) already exists.
- [ ] **T0-4 — Build the companion plugin (skills + scripts).** A Claude Code plugin that reimplements the removed workflows against the lean tools:
  - `render-template` / `preview-bundle` skill → calls `get_template` + `get_creative_asset_group`, runs the (ported) mock-ad generation in a script, writes previewable HTML/CSS to disk.
  - `zone-load-trace` skill → orchestrates `get_zone` (include parents) + `get_zone_ads` (+`debug`) + `get_ad` + `get_template`, assembles the diagnostic locally.
  - Decide home: a `plugins/` dir in this repo vs. a separate plugin repo. (See `plugin-dev`/`skill-creator` tooling.)
- [ ] **T0-5 — Reconcile docs after the cut.** Remove the three tools from CLAUDE.md's Implemented Tools, drop the "composite" pattern from the "how to add a tool" guidance, and note the connection-only principle there so future tools don't reintroduce orchestration.

## Tier 1 — Paid on EVERY request (the tool list / schemas)

- [ ] **T1-1 — Upgrade the SDK.** `^1.12.0` is mid-2024. Bump to current, then adopt the now-normative features below (outputSchema, resources, prompts). Re-test the Streamable HTTP transport + OAuth flow after upgrade.
- [x] **T1-2 — Collapse `get_X_parents` into `get_X`.** DONE — removed all 8 `get_*_parents` tools; the matching `get_X` now takes `include: ["parents"]` and fans out in parallel, returning a stable `{ entity, parents }` shape. Tool surface dropped from **43 → 35**. Helper `getEntityWithIncludes` in `src/tools/_shared.ts`; covered by `src/tests/getEntityWithIncludes.test.ts`.
- [ ] **T1-3 — Move reference/read-only catalogs to MCP Resources.** Networks, dimension sets, event-stats keys, and arguably the `list_*` catalogs are reference data. Resources are *not* sent in the per-turn tool schema and clients can cache them. Candidates: `network_list`, `list_dimension_sets`/`get_dimension_set`, `get_event_stats_keys`. This is also a current-norm gap (zero resources registered).
- [x] **T1-4 — Extract shared input schemas.** DONE (partial) — `paginationShape` + `includeShape` + `READONLY_ANNOTATIONS` live in `src/tools/_shared.ts`; all 13 `list_*` tools now spread `{ ...paginationShape }`. (A reusable `idShape` for the remaining `{ id }`-only schemas is still open but low-value.)
- [ ] **T1-5 — Trim remaining tool descriptions.** Mostly resolved by Tier 0 (the multi-line `Params:` blocks lived on `render_template` / `get_template_preview_bundle`). After the cut, sweep what's left so no description duplicates its schema's `.describe()` text.
- [x] **T1-6 — ~~Tier the surface~~ → superseded by Tier 0.** The composite tools are being removed outright, not gated. No capability flag / split server needed.
- [ ] **T1-7 — Reconcile docs vs. reality.** Folded into T0-5.

## Tier 2 — Paid on EVERY tool call (response shape)

- [x] **T2-1 — Stop pretty-printing JSON.** DONE — dropped `, null, 2` from all 48 call sites across the tools. (NDJSON/CSV for rows still open.)
- [ ] **T2-2 — Add `outputSchema` + `structuredContent` to data tools.** Only `auth_status` returns structured content; nothing defines `outputSchema`. Clients that support structured output currently have to re-parse your text blob. Add to at least every `list_*` and `report_query`. This is a current MCP norm, not an optional nicety. (Needs T1-1.)
- [x] **T2-3 — Fix list truncation — it produced invalid JSON.** DONE — new `listEnvelopeToText` (`workApi.ts`) drops trailing items until the envelope fits, keeping valid JSON and honest `has_more`/`next_offset`/`truncated` metadata. All 13 `list_*` tools use it. Locked in by `src/tests/listEnvelope.test.ts`. **Still open:** single-object `get_*` still route through the char-slicing `truncateIfNeeded` — see T3-1.
- [ ] **T2-4 — The size guard doesn't exist — `RESPONSE_SIZE_LIMIT` is dead code.** The 30k `RESPONSE_SIZE_LIMIT` constant (`constants.ts:6`) and its `response_too_large` behavior described in CLAUDE.md are referenced **nowhere** in `src/`. Either wire it up (wrap every tool's final content in a structured `response_too_large` guard) or delete the constant + fix the CLAUDE.md claim.
- [ ] **T2-5 — Measure in tokens, not characters.** `CHARACTER_LIMIT`/`RESPONSE_SIZE_LIMIT` are char-based. Rename to make the approximation explicit, or budget by an actual token estimate (~3.5 chars/token for JSON).
- [ ] **T2-6 — Verify list projection is opt-out-able correctly.** `projectListItem` keeps only `{id,name}` + ≤2 status fields + caller's `fields`. Confirm an escape hatch exists for full rows, and that `total`/`has_more` are always honest (inferred when upstream omits `total` — `workApi.ts`).

## Tier 3 — Occasional heavy payloads (specific tools)

- [ ] **T3-1 — `get_template` returns full HTML + CSS inline.** After Tier 0 this is the remaining heavy single-entity payload (legitimately connection-shaped — it's one `GET /api/templates/{id}`). A large template still overflows the 25k limit and hits the char-slicing `truncateIfNeeded`. Options: keep the source but ensure truncation is structural (drop `html`/`css`, keep metadata + a note), or add an `include`/`fields`-style toggle so callers opt into the source explicitly.
- [ ] **T3-2 — Confirm `HEAVY_FIELDS` stripping covers template list paths.** `stripListItems` strips `html/css/content/schema/...` from list responses — verify `list_templates` actually routes through it.
- [ ] **T3-3 — `report_query` aggregation stays — harden it.** The deliberate exception to connection-only (response-size management, not orchestration). `aggregateReport` (`reportingTools.ts`) sums numeric fields server-side into a compact total/groups blob. Keep it; just fix `raw: true` to cap row count explicitly (it already dropped the `,2` indentation in T2-1). It's also the pattern to copy for any future high-row endpoint.
- [x] **T3-4 — ~~`zone_load_trace` fan-out~~ → removed by T0-2.**

## Tier 4 — Norms / correctness / UX

- [ ] **T4-1 — Register MCP Prompts** for thin, data-only workflows ("weekly revenue report"). NOTE: the richer workflows ("diagnose a zone", "preview a template") now live in the Tier 0 plugin skills, not in MCP prompts — keep prompts for things that are pure tool sequencing over the lean surface. (Needs T1-1.)
- [ ] **T4-2 — Tool naming consistency.** Mix of `list_/get_` and `auth_/network_`. Pick one convention; consistent prefixes help the model pick tools without extra description text.
- [ ] **T4-3 — Token-expiry UX.** Expired Lincx JWT → every tool 401s, but no proactive detection in `validateSession`. Add expiry detection returning one clear `auth_login` prompt instead of N failed calls.
- [ ] **T4-4 — Confirm `network.networks` shape.** `networkService.ts` still guesses among 4 response shapes. Pin it once known and delete the dead branches.
- [x] **T4-5 — Pagination ergonomics.** DONE — `buildListEnvelope` now returns `next_offset` (null on the last page).
- [ ] **T4-6 — Resource templates for entities.** Once on the new SDK, expose entities as resource templates (e.g. `lincx://campaign/{id}`) so clients can reference/cache them instead of re-calling `get_campaign`.

---

## Suggested execution order
1. **Tier 0** (T0-1 → T0-5) — the scope cut. Removes 3 tools + the largest schemas/payloads, and sets the connection-only boundary before more tools accrete. Build the companion plugin alongside so no capability is lost.
2. **T1-1** (SDK bump) — unblocks T2-2, T1-3, T4-1, T4-6.
3. **T1-3 / T2-2** — resources + structured output on the now-lean surface.
4. **T3-1** — handle the last heavy payload (`get_template` source).
5. Everything else as polish.
