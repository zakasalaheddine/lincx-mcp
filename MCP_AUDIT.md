# lincx-mcp-server — Norms & Token-Consumption Audit

Audit date: 2026-05-25. SDK: `@modelcontextprotocol/sdk@^1.12.0` (stale — see T1-1).
Surface today: **43 registered tools**, 0 resources, 0 prompts, 1 tool using `structuredContent` (`auth_status`), 0 tools with `outputSchema`.

Checklist is ordered by token impact, not by file. Fix Tier 1 first — it pays back on *every request*.

---

## Tier 1 — Paid on EVERY request (the tool list / schemas)

Every `/mcp` turn ships all 43 tool names + descriptions + JSON schemas to the model. This is the single largest, most-repeated token cost. ~25 of the 43 tools are mechanical `list_X` / `get_X` / `get_X_parents` triples.

- [ ] **T1-1 — Upgrade the SDK.** `^1.12.0` is mid-2024. Bump to current, then adopt the now-normative features below (outputSchema, resources, prompts). Re-test the Streamable HTTP transport + OAuth flow after upgrade.
- [ ] **T1-2 — Collapse `get_X_parents` into `get_X`.** Replace ~11 standalone `get_*_parents` tools with an `include: ["parents"]` option on the matching `get_X`. Removes ~11 tool schemas from every request.
- [ ] **T1-3 — Move reference/read-only catalogs to MCP Resources.** Networks, dimension sets, event-stats keys, and arguably the `list_*` catalogs are reference data. Resources are *not* sent in the per-turn tool schema and clients can cache them. Candidates: `network_list`, `list_dimension_sets`/`get_dimension_set`, `get_event_stats_keys`. This is also a current-norm gap (zero resources registered).
- [ ] **T1-4 — Extract shared input schemas.** `{ limit, offset, fields }` and `{ id }` are redefined inline in ~20 tools. Define once (`paginationSchema`, `idSchema`) and reuse. Smaller serialized schemas + consistency.
- [ ] **T1-5 — Audit/trim tool descriptions.** Most are short (good), but `render_template` / `get_template_preview_bundle` carry multi-line `Params:` blocks that duplicate the schema's `.describe()` text. Drop the redundant prose; let the schema carry param docs.
- [ ] **T1-6 — Consider tiering the surface.** Composite/advanced tools (`render_template`, `get_template_preview_bundle`, `zone_load_trace`) have large schemas most users never invoke. Option A: split into two servers (read-only vs. composite). Option B: gate them behind a capability flag. Goal: basic users don't pay advanced-tool schema cost on every turn.
- [ ] **T1-7 — Reconcile docs vs. reality.** `get_template_preview_bundle` exists in code but isn't in CLAUDE.md's tool list; CLAUDE.md count is stale. Keep the implemented-tools list accurate — it's also how you reason about surface size.

## Tier 2 — Paid on EVERY tool call (response shape)

- [ ] **T2-1 — Stop pretty-printing JSON.** `JSON.stringify(data, null, 2)` appears in essentially every tool. The `, 2` indentation is ~30–40% of payload tokens for nested data. Drop it (`JSON.stringify(data)`), or better, emit NDJSON/CSV for list/report rows.
- [ ] **T2-2 — Add `outputSchema` + `structuredContent` to data tools.** Only `auth_status` returns structured content; nothing defines `outputSchema`. Clients that support structured output currently have to re-parse your text blob. Add to at least every `list_*` and `report_query`. This is a current MCP norm, not an optional nicety.
- [ ] **T2-3 — Fix `truncateIfNeeded` — it produces invalid JSON.** `src/services/workApi.ts:234` slices a serialized JSON string at `CHARACTER_LIMIT` (25k chars) and appends a note → the model receives unparseable JSON. Truncate at the **envelope level**: drop items from the array, keep `total` / `has_more` / a `next_offset`, never cut mid-structure. (`buildListEnvelope` already gives you the seam to do this.)
- [ ] **T2-4 — Make the size guard return clean structured errors.** `RESPONSE_SIZE_LIMIT` (30k) is described as dropping oversized payloads into a `response_too_large` error — verify that path actually exists and returns a structured, actionable message ("narrow your date range / lower limit"), not a raw slice.
- [ ] **T2-5 — Measure in tokens, not characters.** `CHARACTER_LIMIT`/`RESPONSE_SIZE_LIMIT` are char-based. Either rename to make the approximation explicit, or budget by an actual token estimate (~3.5 chars/token for JSON) so the limit maps to a real context cost.
- [ ] **T2-6 — Verify list projection is opt-out-able correctly.** `projectListItem` keeps only `{id,name}` + ≤2 status fields + caller's `fields`. Good default. Confirm `fields: ["*"]` or similar escape hatch exists for when the user genuinely needs full rows, and that `total`/`has_more` are always honest (currently inferred when upstream omits `total` — `workApi.ts:224`).

## Tier 3 — Occasional heavy payloads (specific tools)

- [ ] **T3-1 — `render_template` / `get_template_preview_bundle` dump full HTML + CSS inline** (`templateTools.ts:213`, `:230+`). A real template easily exceeds the 25k limit → hits the mid-JSON truncation bug (T2-3). Options: return HTML/CSS as separate resource links/embedded resources the client fetches on demand; or return a size + a `get_template_source(id, part)` fetch tool; or hard-cap and link.
- [ ] **T3-2 — Confirm `HEAVY_FIELDS` stripping covers template list paths.** `stripListItems` strips `html/css/content/schema/...` from list responses — verify `list_templates` actually routes through it (templateTools predates the shared envelope helpers in places).
- [ ] **T3-3 — `report_query` aggregation is the right pattern — extend it.** `aggregateReport` (`reportingTools.ts:165`) sums numeric fields server-side and returns a compact total/groups blob. This is the model to copy for any other high-row endpoint. Also: `raw: true` still pretty-prints all rows (`:131`) → drop the `,2` there and cap row count explicitly.
- [ ] **T3-4 — `zone_load_trace` fan-out** — confirm the composite blob is itself projected/capped, not a concatenation of full sub-responses.

## Tier 4 — Norms / correctness / UX (lower token impact, still "good MCP")

- [ ] **T4-1 — Register MCP Prompts** for the common workflows ("diagnose a zone", "weekly revenue report", "preview a template"). Zero prompts today; they're a cheap discoverability win and steer the model toward the efficient composite tools.
- [ ] **T4-2 — Tool naming consistency.** Mix of `list_/get_` (business tools) and `auth_/network_` (verb_noun). Pick one convention; consistent prefixes help the model pick tools without extra description text.
- [ ] **T4-3 — Token-expiry UX.** CLAUDE.md flags it: expired Lincx JWT → every tool 401s with a re-login hint, but no proactive detection in `validateSession`. Add expiry detection returning one clear `auth_login` prompt instead of N failed calls (each failed call is wasted tokens).
- [ ] **T4-4 — Confirm `network.networks` shape.** `networkService.ts` still guesses among 4 response shapes (CLAUDE.md "Network response shape unconfirmed"). Pin it once known and delete the dead branches.
- [ ] **T4-5 — Pagination ergonomics.** Return `next_offset` explicitly in the envelope rather than making the model compute `offset+limit`. Saves a reasoning step and a likely follow-up call.
- [ ] **T4-6 — Resource templates for entities.** Once on the new SDK, expose entities as resource templates (e.g. `lincx://campaign/{id}`) so clients can reference/cache them instead of re-calling `get_campaign`.

---

## Suggested execution order
1. **T2-1, T2-3** — biggest, lowest-risk token wins, no API changes. Do today.
2. **T1-1** (SDK bump) — unblocks T2-2, T1-3, T4-1, T4-6.
3. **T1-2, T1-4** — shrink the per-request surface.
4. **T3-1** — kill the one path that reliably blows the size limit.
5. Everything else as polish.
