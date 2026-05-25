# lincx-mcp-server — Norms & Token-Consumption Audit

Audit date: 2026-05-25 (rev 4 — Tier 0 cut + SDK bump done).
SDK: `@modelcontextprotocol/sdk@^1.29.0` (current).
Surface today: **32 registered tools** (down from 43), 0 resources, 0 prompts,
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

- [x] **T0-1 — Remove `render_template` + `get_template_preview_bundle`** + the `generateMockAds` helper from `templateTools.ts`. DONE.
- [x] **T0-2 — Remove `zone_load_trace`** from `zoneTools.ts`. DONE.
- [x] **T0-3 — Expose the one endpoint the trace skill would otherwise lose.** DONE — added a `debug: boolean` flag to `get_zone_ads` (`/api/ads/ad` vs `/api/ads/ad/debug`). All other endpoints the skills need (`get_template`, `get_creative_asset_group`, `get_zone` with parents, `get_ad`) already exist.
- [~] **T0-4 — Build the companion plugin (skills + scripts).** OWNED ELSEWHERE — lives in the user's separate skills/plugins repo, not this one. The MCP side is ready: it exposes `get_template`, `get_creative_asset_group`, `get_zone` (`include:['parents']`), `get_zone_ads` (`+debug`), `get_ad`, `get_template_version(s)` — everything the render/preview and zone-trace skills need. (Port `generateMockAds` from git history `templateTools.ts` into the render skill.)
- [x] **T0-5 — Reconcile docs after the cut.** DONE — removed the 3 tools from CLAUDE.md's Implemented Tools, added a "Scope: connection only" section to CLAUDE.md, and noted the `get_zone_ads` debug flag.

## Tier 1 — Paid on EVERY request (the tool list / schemas)

- [x] **T1-1 — Upgrade the SDK.** DONE — the `^1.12.0` floor had already resolved to 1.27.1 installed; bumped to `^1.29.0` (latest) and pinned the floor. Verified end-to-end after the bump: build + 36 tests pass, server boots clean, `/mcp` still returns the RFC-9728 `401 WWW-Authenticate` challenge, and both `.well-known` OAuth metadata endpoints serve 200. Unblocks T1-3 (resources), T2-2 (outputSchema), T4-1 (prompts), T4-6.
- [x] **T1-2 — Collapse `get_X_parents` into `get_X`.** DONE — removed all 8 `get_*_parents` tools; the matching `get_X` now takes `include: ["parents"]` and fans out in parallel, returning a stable `{ entity, parents }` shape. Tool surface dropped from **43 → 35**. Helper `getEntityWithIncludes` in `src/tools/_shared.ts`; covered by `src/tests/getEntityWithIncludes.test.ts`.
- [x] **T1-3 — Move reference catalogs to MCP Resources — scoped (deliberate).** DONE in `src/tools/resources.ts`: added `lincx://networks` (static resource; the `network_list` tool stays as the discovery surface). **Intentionally did NOT move `list_dimension_sets`/`get_dimension_set`/`get_event_stats_keys`** — these are workflow *inputs* to `report_query`, and the model discovering them via a planned tool call is far more reliable than hoping it browses a resource (resource-read is model/client-driven and unevenly supported). The token win from removing 3 tiny catalog schemas didn't justify degrading the core reporting flow. Verified e2e (real client over InMemoryTransport sees `resources/list` + reads it). Covered by `src/tests/resources.test.ts`.
- [x] **T1-4 — Extract shared input schemas.** DONE (partial) — `paginationShape` + `includeShape` + `READONLY_ANNOTATIONS` live in `src/tools/_shared.ts`; all 13 `list_*` tools now spread `{ ...paginationShape }`. (A reusable `idShape` for the remaining `{ id }`-only schemas is still open but low-value.)
- [x] **T1-5 — Trim remaining tool descriptions.** DONE — removed the leftover `Params:` prose blocks from `list_templates` and `list_creative_asset_groups` (they duplicated `paginationShape`'s `.describe()` text). No descriptions now restate their schema.
- [x] **T1-6 — ~~Tier the surface~~ → superseded by Tier 0.** The composite tools are being removed outright, not gated. No capability flag / split server needed.
- [ ] **T1-7 — Reconcile docs vs. reality.** Folded into T0-5.

## Tier 2 — Paid on EVERY tool call (response shape)

- [x] **T2-1 — Stop pretty-printing JSON.** DONE — dropped `, null, 2` from all 48 call sites across the tools. (NDJSON/CSV for rows still open.)
- [x] **T2-2 — Add `outputSchema` + `structuredContent` — scoped to `report_query` only (deliberate).** DONE for `report_query`; intentionally NOT applied to the 13 `list_*`. Rationale: the SDK requires *both* a `content` text block and a schema-valid `structuredContent` (it can't auto-derive one from the other), and `outputSchema` ships in the tool definition on every request. For Claude clients the model reads `content`, not `structuredContent`, so adding it to all list tools would be pure duplication + 13 extra per-request schemas — directly against the lean-server goal. `report_query` is the one tool where typed numeric output earns its keep for client tooling. One schema covers both modes (aggregated `total`/`groups`, and `raw`); both branches return `structuredContent`. Covered by `src/tests/reportQuery.structured.test.ts` (validates against the tool's own `outputSchema`). The stub-content workaround was rejected as spec-noncompliant.
- [x] **T2-3 — Fix list truncation — it produced invalid JSON.** DONE — new `listEnvelopeToText` (`workApi.ts`) drops trailing items until the envelope fits, keeping valid JSON and honest `has_more`/`next_offset`/`truncated` metadata. All 13 `list_*` tools use it. Locked in by `src/tests/listEnvelope.test.ts`. **Still open:** single-object `get_*` still route through the char-slicing `truncateIfNeeded` — see T3-1.
- [x] **T2-4 — Size guard exists and works — earlier "dead code" finding was WRONG.** Correction: `RESPONSE_SIZE_LIMIT` *is* wired up — `installToolGuards` (`middleware/toolGuard.ts`, called in `index.ts` createMcpServer) wraps every tool handler, measures `JSON.stringify(result).length`, and returns a structured `response_too_large` `isError` result over the limit, plus a per-call metrics line. My rev-1 claim came from a broken `grep --include` that errored silently under zsh. The CLAUDE.md/constants description is accurate. Added the missing test coverage: `src/tests/toolGuard.test.ts` (passthrough / oversized→response_too_large / error propagation). Two notes, both acceptable, not bugs: (a) it measures chars not bytes — see T2-5; (b) resource reads (`resources.ts`) are not guarded — fine, resources are pull-based and client-initiated. One real interaction to know: `report_query`'s untruncated `structuredContent` now counts toward the measured size, so a large `raw:true` report can trip the guard and return `response_too_large` instead of truncated rows — the right safety behavior for an explicitly-large opt-in path.
- [x] **T2-5 — Make the char-vs-token approximation explicit.** DONE — documented both `CHARACTER_LIMIT` and `RESPONSE_SIZE_LIMIT` as char-based rough token proxies (~3–4 chars/token), and fixed the `response_bytes` misnomer in the toolGuard metrics → `response_chars` (it always measured `.length`). Kept char-based budgeting rather than pulling in a tokenizer dependency — the rough proxy is fine for a size *safeguard*.
- [x] **T2-6 — List projection now has a full-row escape hatch.** DONE — `fields: ['*']` returns the unprojected row (heavy fields still stripped upstream; `listEnvelopeToText` still caps total size). Default projection (`{id,name}` + ≤2 status + named `fields`) unchanged. `total`/`has_more`/`next_offset` confirmed honest (upstream total used when present, else inferred from a full page). Covered in `src/tests/listEnvelope.test.ts`.

## Tier 3 — Occasional heavy payloads (specific tools)

- [x] **T3-1 — Single-entity `get_*` no longer emit invalid JSON.** DONE — new `fitEntityToText` (`workApi.ts`) replaces `truncateIfNeeded` on every single-entity `get_*` (campaign, ad, ad-group, channel, creative, site, publisher, advertiser, experience, creative-asset-group, zone, template, template-version(s), get_zone_ads). It elides the largest STRING leaves one at a time, largest-first, until the payload fits — always valid JSON — and attaches a `_truncated` note listing the elided field *paths* (e.g. `html`, `entity.css`) pointing to the resource URI / a more specific tool. Invariant (`JSON.parse` never throws) locked by `src/tests/fitEntity.test.ts`. **Two filed gaps, intentionally not in scope here:** (a) `get_zone_report` stays on `truncateIfNeeded` — it's a timeseries array, so the right fix is structural point-dropping like `listEnvelopeToText`, not string-eliding; (b) the `_truncated` note's pointer is generic prose — a future tweak could compose the exact `lincx://template/{id}` URI at the call site (needs each get_X to pass its entity-segment + id).
- [ ] **T3-2 — Confirm `HEAVY_FIELDS` stripping covers template list paths.** `stripListItems` strips `html/css/content/schema/...` from list responses — verify `list_templates` actually routes through it.
- [ ] **T3-3 — `report_query` aggregation stays — harden it.** The deliberate exception to connection-only (response-size management, not orchestration). `aggregateReport` (`reportingTools.ts`) sums numeric fields server-side into a compact total/groups blob. Keep it; just fix `raw: true` to cap row count explicitly (it already dropped the `,2` indentation in T2-1). It's also the pattern to copy for any future high-row endpoint.
- [x] **T3-4 — ~~`zone_load_trace` fan-out~~ → removed by T0-2.**

## Tier 4 — Norms / correctness / UX

- [ ] **T4-1 — Register MCP Prompts** for thin, data-only workflows ("weekly revenue report"). NOTE: the richer workflows ("diagnose a zone", "preview a template") now live in the Tier 0 plugin skills, not in MCP prompts — keep prompts for things that are pure tool sequencing over the lean surface. (Needs T1-1.)
- [x] **T4-2 — Tool naming — reviewed, deliberately WON'T-DO.** The surface is already prefix-grouped (`auth_*`, `network_*`, `list_*`, `get_*`, `report_query`) which is what actually helps the model select tools. The only "inconsistency" is verb/noun ordering (`get_campaign` vs `network_list`), and `auth_login` / `network_switch` are idiomatic, clear names. Renaming them is a **breaking change to the tool API** (clients/skills call by name) for a cosmetic gain — not worth it. Revisit only if a future rename is already breaking things for another reason.
- [x] **T4-3 — Token-expiry UX.** DONE — `validateSession` now decodes the Lincx JWT's `exp` claim (unverified read via `isJwtExpired` in `auth.ts`; the Work API still verifies the signature) and short-circuits with "Your Lincx session has expired. Use 'auth_login' to sign in again." before any Work API call. Fails open when `exp` is unreadable (lets the API 401 be the authority). Covered by `src/tests/tokenExpiry.test.ts` (helpers + the validateSession gate).
- [ ] **T4-4 — Confirm `network.networks` shape.** `networkService.ts` still guesses among 4 response shapes. Pin it once known and delete the dead branches.
- [x] **T4-5 — Pagination ergonomics.** DONE — `buildListEnvelope` now returns `next_offset` (null on the last page).
- [x] **T4-6 — Resource templates for entities.** DONE (folded into T1-3) — `lincx://{entity}/{id}` templates for all 13 get-by-id entity types in `src/tools/resources.ts`. Templates carry no list callback, so they don't appear in `resources/list` and add zero per-request token cost; they let clients reference/cache entities the model has already touched.

---

## Suggested execution order
1. **Tier 0** (T0-1 → T0-5) — the scope cut. Removes 3 tools + the largest schemas/payloads, and sets the connection-only boundary before more tools accrete. Build the companion plugin alongside so no capability is lost.
2. **T1-1** (SDK bump) — unblocks T2-2, T1-3, T4-1, T4-6.
3. **T1-3 / T2-2** — resources + structured output on the now-lean surface.
4. **T3-1** — handle the last heavy payload (`get_template` source).
5. Everything else as polish.
