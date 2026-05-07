# Lincx Reports — Skill Pack Design

**Date:** 2026-05-07
**Status:** Draft for review
**Owner:** Salaheddine Zaka

## Goal

Give managers (engineering, product, account/campaign, customer success) a small set of Claude skills that turn the existing `lincx-mcp-server` reporting primitives into purposeful, manager-friendly reports. The skills carry no credentials and add no new API capability; they orchestrate the MCP tools that already exist.

## Non-goals

- New MCP tools, endpoints, or auth changes.
- Charting, image rendering, or PDF export.
- Pacing / budget-burn projections (deferred — could be a future skill).
- Recommendations or "next steps" output unless the user asks for them.
- Defaulting time ranges on the user's behalf.

## Constraints

- Read-only by default. Any future write capability must be opt-in per skill.
- The MCP server is the trust boundary: it owns auth, network scoping, and the Lincx JWT. Skills never see credentials.
- `report_query` does not accept a structured filter object. Entity scoping happens through the dimension set's available `dimensions` plus client-side narrowing of the returned rows.
- Resolution is `day` or `hour` only. Multi-week or month comparisons are constructed from daily rows in the skill, not requested as a coarser resolution.
- Output must render correctly in both Claude Code and Claude Desktop — no charts, no HTML.

## Architecture

The skills ship as a Claude Code plugin that installs into both Claude Code and Claude Desktop:

```
mcp/plugins/lincx-reports/
├── plugin.json
└── skills/
    ├── lincx-reports/                   # router (top-level)
    │   └── SKILL.md
    ├── lincx-campaign-performance/
    │   ├── SKILL.md
    │   └── references/
    │       └── dimension-cheatsheet.md
    ├── lincx-revenue-summary/
    │   └── SKILL.md
    ├── lincx-creative-anomalies/
    │   └── SKILL.md
    └── _shared/
        ├── date-range.md
        ├── output-template.md
        ├── dimension-discovery.md
        └── mcp-call-patterns.md
```

The plugin source lives in the `mcp/` repo so the server and the skills that consume it ship from one place.

## Components

### Router: `lincx-reports/SKILL.md`

Trigger description covers the family: performance, revenue, fill, RPM, creative, placement, winners, drops, anomalies — combined with Lincx, advertiser, campaign, network, zone, site. Body is short:

- Decision table: intent → which sub-skill to load.
- One hard rule: if the user has not specified a date range, ask before doing anything else (do not start tool calls).
- Reminds Claude that on `"Error: Not authenticated"` from any tool, ask the user to run `auth_login` and stop. On no active network, surface `network_list` results and ask which to switch to.

### `lincx-campaign-performance/SKILL.md`

Owns "how did campaign(s) X perform from A to B."

Flow:

1. Resolve date range via `_shared/date-range.md`. Never default.
2. Resolve campaign(s): `list_campaigns({ limit: 100 })` paginated until a name match is found. If multiple match, list candidates with IDs and ask. If none match, surface the closest names and ask.
3. Pick a dimension set per `_shared/dimension-discovery.md`. Prefer one whose dimensions include `campaign_id` (or the network's equivalent — discovered, not assumed).
4. `report_query({ dimensionSetId, startDate, endDate, resolution: "day", dimensions: ["date","campaign_id"] })`.
5. Filter the returned rows client-side to the resolved campaign ID(s).
6. Render via `_shared/output-template.md` with column order `date | spend | impressions | clicks | conversions | ctr | ecpm`.

`references/dimension-cheatsheet.md` records the team's canonical dimension-set names for campaign perf and the metrics that matter, but the skill always verifies via `get_dimension_set` rather than trusting the cheatsheet.

### `lincx-revenue-summary/SKILL.md`

Owns "revenue / fill / RPM by advertiser / network / site for period P."

Flow mirrors campaign-performance with two differences:

- Entity resolution branches on advertiser vs network vs site (`list_advertisers`, `list_sites`, plus `network_list` for active context). If the user named no entity, the skill asks before querying — does not pick one.
- Default breakdown is the named entity itself (single-axis), not a date series. The narrative still gives a totals row; column order is `<entity> | revenue | impressions | fill_rate | rpm` plus a totals row at the bottom.

When the user names multiple entity types in one ask ("revenue by advertiser and site"), the skill runs two separate `report_query` calls and emits two tables, not a Cartesian breakdown.

### `lincx-creative-anomalies/SKILL.md`

Owns "what's working / broken among creatives, zones, sites, templates."

Two modes, branched early from the user's wording:

- **Winners / losers**: one date range; one `report_query` with the chosen entity dimension; sort client-side; render top N + bottom N (default N = 10, asks if user wants different).
- **Anomaly**: needs current and prior ranges. The skill asks for the comparison window if not given — never assumes "vs prior period of equal length." Two `report_query` calls; join on entity key client-side; compute `delta_pct` and require `current_volume ≥ floor` (auto-derived from the data: ~10% of the median row volume, asked-to-confirm if it would drop everything). Threshold default is `±25%`; if no rows clear it, the skill says so and asks whether to lower it.

For single-zone questions, the skill prefers `get_zone_report` directly — cheaper and bypasses dimension-set selection.

### Shared helpers (loaded only when a sub-skill cites them)

- **`_shared/date-range.md`** — explicit-date parser. Knows ISO dates, "March 1–15", "yesterday", "last week" only when grounded against today's date. If anything is ambiguous (year, time zone, inclusive/exclusive end date), asks the user. Forbids inventing ranges.
- **`_shared/dimension-discovery.md`** — algorithm: call `list_dimension_sets`, inspect candidates with `get_dimension_set`, prefer ones whose dimensions cover the requested breakdown, use `get_event_stats_keys` to verify the network actually emits the keys you plan to filter on. Falls back to asking the user with the candidate list. Caches the catalog for one turn (do not call `list_dimension_sets` twice).
- **`_shared/mcp-call-patterns.md`** — canonical `report_query` shape; the "no structured filters; breakdown + client-side filter" pattern with examples; resolution rules (`day` vs `hour` only); pagination for `list_*` tools.
- **`_shared/output-template.md`** — the strict output contract (see below).

### Plugin manifest (`plugin.json`)

Declares plugin name, version, the four skills, and a recommendation that the `lincx` MCP server be configured. Includes a short README pointing at `mcp/README.md` for the auth flow.

## Data flow

Happy path — campaign performance:

```
User: "How did the Acme campaign do March 1–15?"
  │
Router (lincx-reports) matches → loads lincx-campaign-performance
  │
Sub-skill steps Claude through:
  1. date-range.md parses "March 1–15" → asks user "March 2026 or March 2025?"
     before committing to a range (year is always confirmed when not given)
  2. list_campaigns({ limit: 100 }) → resolves "Acme" to campaign ID
                                      (pagination + ask if >1 match)
  3. list_dimension_sets() → candidates → get_dimension_set(id) on the
     best match → confirms `campaign_id` is a dimension
  4. report_query({
       dimensionSetId, startDate, endDate,
       resolution: "day",
       dimensions: ["date", "campaign_id"]
     })
  5. Filter rows client-side to the resolved campaign ID
  6. output-template.md → narrative + table + footer
```

Revenue and creative-anomalies follow the same backbone with the variations noted in Components.

State and caching: none. Each invocation is stateless. The MCP server holds session/network. Skills do not persist anything between calls. Tool-call budget is ≤ 5 per turn in the common case (1 entity-list + 1 list_dimension_sets + 1 get_dimension_set + 1–2 report_query). The skill explicitly tells Claude not to call `list_dimension_sets` more than once per turn.

## Error, empty, and large-result handling

- **Auth / session errors** (`"Error: Not authenticated…"`, validation errors): surface plainly, ask user to run `auth_login` (and `network_list` → `network_switch` if no active network). Do not retry the same call.
- **No matching dimension set**: stop. List available sets and dimensions. Ask which to use.
- **Ambiguous entity name**: list all matches with IDs and ask. Paginate `list_*` tools and filter by name client-side rather than guessing.
- **Empty result set**: narrate "No data for `<range>` filtered to `<entity>` using dimension set `<name>`," then suggest one diagnostic (wider range, drop a filter, or `auth_status` / `network_list`).
- **Truncated MCP response** (the server runs `truncateIfNeeded`): detect via cut-off JSON; do not synthesize numbers from a partial body. Tell the user explicitly: "Response was truncated — narrow the date range or breakdown."
- **Large result that fits** (e.g., 720 hourly rows): cap the rendered table at 30 rows; collapse to daily aggregate or top-N + bottom-N as the sub-skill dictates; offer to show specific dates.
- **Anomaly with no rows clearing the threshold**: state plainly; offer to lower threshold or floor; do not silently lower them.
- **Suspicious zero rows** (known-active campaign returns nothing): suggest `get_event_stats_keys` and `auth_status`. Do not run automatically.
- **Network errors / 5xx**: surface verbatim, suggest one retry, then stop.

## Output template

Defined in `_shared/output-template.md`. Four parts in order:

1. **Headline (≤ 25 words, 1 sentence)** — leads with the most decision-relevant number for the report. Always names the entity and date range. No hedging adjectives.
2. **Narrative (2–4 sentences)** — explains the headline; cites the one row or driver that matters most; says "nothing notable" when that's true; never speculates on cause.
3. **Markdown table** — capped at 30 rows; column order fixed per report (in each sub-skill's `references/`); numbers right-aligned; currency `$` with 2 decimals; rates `12.3%`; counts with thousands separators; sort chronological for time series, descending by primary metric for ranks, descending by `|delta_pct|` for anomalies.
4. **Footer** — `Source: dimension set "<name>" (<id>) · range <YYYY-MM-DD> → <YYYY-MM-DD>  · resolution <day|hour> · network <active_network>`. Truncation appends a second line.

Forbidden: emoji; first person; "based on the data" filler; charts; unsolicited recommendations.

## Testing

Three layers:

1. **Static checks (vitest, in CI alongside the MCP server's existing tests)** — every `SKILL.md` is parsed and asserted: frontmatter has `name` and `description`; description is ≤ 200 chars and matches the trigger-vocabulary list; every tool name referenced in a skill body exists in `src/tools/*.ts`; every `_shared/*.md` reference resolves. This catches the failure mode that breaks skills silently — drift between skill prose and the actual MCP surface.
2. **Golden transcript tests (manual, pre-release)** — `tests/golden/<report>.md` for each of the three reports: a representative prompt, the MCP tool calls Claude should make in order, and the expected output template shape (sections present, column names correct — not exact numbers). Reviewed by eye before each release. Doubles as documentation.
3. **Live smoke test (manual, ~10 min, pre-release)** — run the three canonical prompts against the real MCP in Claude Code; confirm the four output sections render; confirm the footer's source line matches the dimension set actually used.

Out of scope: asserting narrative wording (fights the model); number-format unit tests in isolation (covered by smoke); MCP tool tests (already covered in the server's suite).

## Open questions / future work

- Pacing & delivery health is deferred but is the most-likely 4th sub-skill. Adding it should not require changes to the shared helpers.
- A `zone-load-trace` diagnostic skill (wrapping the existing `zone_load_trace` tool) is a natural extension for support engineers.
- Whether to publish the plugin to a public marketplace or keep it private to the workspace is a release-time question.

## Acceptance criteria

- All four `SKILL.md` files exist and parse cleanly.
- The static-check vitest suite passes for the plugin.
- A new manager who has never seen the system can ask each of the three canonical prompts in Claude Desktop (with the `lincx` MCP configured) and receive a response matching the four-part output template.
- No skill ever produces a number without a footer that names the dimension set, range, resolution, and active network.
- No skill defaults a date range; ambiguity always prompts a question.
