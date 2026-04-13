# Lincx MCP + Plugin Marketplace — Architecture Plan

> Status: planning doc for `lincx-mcp` and the companion Claude Code plugin marketplace.
> Owner: Salah. Last updated: 2026-04-13.
>
> Scope note: authentication and the networks resource (list/get/set-active/refresh)
> are already implemented and are intentionally out of scope for this doc.

---

## 1. Goals

Build a bridge between LLMs (Claude Code, Claude.ai) and the Lincx SaaS that lets
Managers, Clients, and Engineers operate the platform through natural language —
without exposing the full destructive power of the underlying API.

Three concrete v1 objectives:

1. **Zone debugging.** Pull the full entity tree for a zone (config → ad-groups →
   ads → creatives → template) and answer questions about why a zone is or isn't
   serving. Includes debugging from a real client URL via Playwright.
2. **Template coding loop.** Edit templates with iterative render previews,
   optionally rendered against live ads from a real zone. Never write without
   explicit user confirmation.
3. **Reporting in natural language.** Translate plain-English questions into
   report queries, fetch the numbers, analyze, and answer.

Distribution is a **Claude Code Plugin Marketplace** so the team can install
skills/agents/hooks per workflow, with QA elicitation built in.

---

## 2. Two-layer split

```
┌─────────────────────────────────────────────────────────────┐
│  lincx-marketplace (plugins repo)                           │
│  Skills, subagents, hooks, slash commands. Workflows live   │
│  here. No business logic.                                   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  lincx-mcp (capability surface)                             │
│  Tools that wrap the Lincx SaaS API. Stateless (in-memory   │
│  session only). Role gating + structured logs.              │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
              lincx-client-api (78 paths, multi-tenant)
```

**Rule:** the MCP is the capability surface, plugins are the workflows. New
plugins ship without touching the MCP. New SaaS endpoints ship as new tools
without touching plugins.

---

## 3. lincx-mcp

### 3.1 Tech stack

- **Runtime:** Node.js 20+ / TypeScript
- **MCP framework:** `@modelcontextprotocol/sdk`
- **Transport:** HTTP + SSE (streamable HTTP). Stdio for local dev only.
- **HTTP client:** `ky` or `undici` with retry + timeout
- **Validation:** `zod`
- **State:** in-memory `Map` per process. No Redis, no Postgres.
- **Logs:** structured NDJSON to stdout, captured by Coolify
- **Hosting:** Coolify, single container, Traefik route (e.g. `mcp.zakadev.com`)

### 3.2 Environment

```
LINCX_API_BASE        # Lincx SaaS API root
LOG_LEVEL             # info | debug
PORT                  # 3000
```

(Auth-related env is already set up and owned by the auth layer — not
re-specified here.)

### 3.3 Repo layout

```
lincx-mcp/
├── src/
│   ├── server.ts                 # MCP bootstrap, HTTP/SSE transport
│   ├── session/
│   │   └── store.ts              # in-memory Map<sessionId, SessionState>
│   ├── lincx-client/
│   │   ├── client.ts             # HTTP wrapper, injects networkId
│   │   ├── types.ts              # generated from swagger (openapi-typescript)
│   │   └── retry.ts
│   ├── tools/
│   │   ├── _registry.ts          # tool registration + role gating
│   │   ├── _shared/
│   │   │   ├── pagination.ts
│   │   │   └── errors.ts
│   │   ├── zones/
│   │   │   ├── list.ts
│   │   │   ├── get.ts
│   │   │   └── trace.ts          # composite: zone_load_trace
│   │   ├── ads/
│   │   ├── ad-groups/
│   │   ├── campaigns/
│   │   ├── creatives/
│   │   ├── templates/
│   │   │   ├── get.ts
│   │   │   ├── render.ts         # composite: render_template (sandbox)
│   │   │   └── update-draft.ts   # write, gated to engineer
│   │   ├── advertisers/
│   │   ├── publishers/
│   │   ├── channels/
│   │   ├── sites/
│   │   ├── experiences/
│   │   └── reports/
│   │       ├── query.ts
│   │       └── event-stats-keys.ts
│   ├── composites/
│   │   ├── zone-load-trace.ts    # orchestration logic, tool-agnostic
│   │   └── template-render.ts    # sandbox runner
│   ├── logging/
│   │   └── audit.ts              # NDJSON to stdout
│   └── config.ts
├── test/
├── docker/Dockerfile
└── package.json
```

### 3.4 Tool tiers

Don't expose 134 endpoints as 134 tools. LLMs pick badly from large flat lists
and you leak write power. Three tiers:

**Tier 1 — Read primitives** (all roles)
One `get_*` and one `list_*` per resource: zones, ads, ad-groups, campaigns,
creatives, templates, advertisers, publishers, channels, sites, experiences.
Plus `get_parents` on each (available on every resource).

**Tier 2 — Composite/intent tools** (the real value)
- `zone_load_trace(zoneId)` — fans out: zone → parents → matched ad-groups →
  ads → creatives → template → recent event-stats. One structured blob.
  Powers Objective 1.
- `zone_top_ads(zoneId, params)` — wraps `/api/ads/ad` + `/api/ads/ad/debug`
  with matching explanation.
- `render_template(templateId, version?, ads?, zoneId?)` — wraps fetch +
  sandboxed render. If `zoneId` given, pulls live ads. Returns HTML +
  screenshot. Powers Objective 2.
- `report_query(dimensionSetId, filters, dateRange)` — wraps
  `/api/reports/{dimensionSetId}` with sane defaults. Powers Objective 3.
- `event_stats_keys()` — discovery for what filters are available on the
  active network.

**Tier 3 — Write tools** (role-gated, off by default)
`update_template_draft`, `patch_zone`, `patch_ad`, etc. Each checks role
before executing. Prefer PATCH endpoints (`/{id}/patch`) over PUT for partial
updates. Clients never see these.

### 3.5 Tool registry pattern

```ts
// tools/_registry.ts
type ToolDef = {
  name: string;
  description: string;
  inputSchema: ZodSchema;
  requiredRole: 'viewer' | 'engineer' | 'manager';
  requiresNetwork: boolean;
  handler: (input, ctx) => Promise<ToolResult>;
};

export const tools: ToolDef[] = [
  listZones, getZone, zoneLoadTrace,
  // ...
];
```

Server iterates this on startup and registers with the SDK. Adding a tool =
one file + one import. No central switch.

### 3.6 Roles

Role identity is resolved by the auth layer and available on the session
context. The MCP only consumes it for gating:

| Role       | Tools available                                           |
| ---------- | --------------------------------------------------------- |
| `viewer`   | All Tier 1 + 2 read tools, scoped to assigned networks    |
| `engineer` | Adds Tier 3 writes on templates/zones/ads, all networks   |
| `manager`  | Everything including admin-level writes                   |

### 3.7 Session state

In-memory `Map<sessionId, SessionState>`:

```ts
type SessionState = {
  userId: string;
  role: 'viewer' | 'engineer' | 'manager';
  activeNetworkId?: string;
  createdAt: number;
};
```

Sessions pruned after 24h. Lost on container restart — the already-shipped
network selection flow re-populates `activeNetworkId`, costs ~2 seconds,
acceptable.

When horizontal scale matters, either turn on Traefik sticky sessions or
move active network into the session token. Don't solve until you hit it.

### 3.8 Request lifecycle

```
LLM client
   │  (1) MCP call: zone_load_trace({ zoneId })
   ▼
server.ts
   ├── (2) auth layer resolves user + role (already implemented)
   ├── (3) load session from Map
   ├── (4) tool registry lookup
   ├── (5) role gate
   ├── (6) zod validate input
   ├── (7) dispatch to composite/tool
   │     │
   │     ▼
   │   lincx-client → SaaS API (parallel where possible)
   │     │
   │     ▼
   │   return structured result + summary string
   │
   └── (8) audit.logToolCall(...) → stdout NDJSON
```

### 3.9 Composite: `zone_load_trace`

The model for all composites.

```ts
async function zoneLoadTrace({ zoneId }, ctx) {
  const [zone, parents, topAds, eventKeys] = await Promise.all([
    api.get(`/api/zones/${zoneId}`),
    api.get(`/api/zones/${zoneId}/parents`),
    api.get(`/api/ads/ad`, { query: { zoneId, debug: true } }),
    api.get(`/api/event-stats`, { query: { zoneId } }),
  ]);

  const ads = await Promise.all(
    topAds.matched.map(a => api.get(`/api/ads/${a.id}`))
  );
  const templateIds = unique(ads.map(a => a.templateId).concat(zone.templateId));
  const templates = await Promise.all(
    templateIds.map(id => api.get(`/api/templates/${id}`))
  );

  return {
    zone, parents,
    matching: { matched: topAds.matched, rejected: topAds.rejected, reasons: topAds.debug },
    ads, templates,
    recentEvents: eventKeys,
    summary: buildHumanSummary(zone, ads, topAds.debug),
  };
}
```

Returns both structured data (for LLM reasoning) and a `summary` string
(for quick chat render).

### 3.10 Composite: `render_template`

Two modes:

- **Fixture render** — LLM provides synthetic ads, server renders to HTML in a
  sandboxed Node VM (or headless Chromium tab), screenshots, returns HTML +
  screenshot URL.
- **Live render** — LLM provides `zoneId`, server calls `zone_top_ads` for real
  ads, then renders.

**Critical:** never writes. A separate `update_template_draft` (gated to
`engineer`) handles persistence, writing to a draft version via
`/api/templates/{id}/versions`.

Sandbox has no network access except whitelisted asset CDNs. Templates are
user code; treat as untrusted.

### 3.11 Logging (the whole thing)

```ts
// logging/audit.ts
type AuditEvent = {
  ts: string;
  level: 'info' | 'warn' | 'error';
  event: 'tool_call';
  user_id: string;
  network_id?: string;
  role: string;
  tool: string;
  input: unknown;
  status: 'ok' | 'error' | 'denied';
  error_code?: string;
  duration_ms: number;
  trace_id: string;
};

export function logToolCall(e: Omit<AuditEvent, 'ts' | 'level' | 'event'>) {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    level: e.status === 'error' ? 'error' : 'info',
    event: 'tool_call',
    ...e,
  }) + '\n');
}
```

NDJSON, one line per tool call. Searchable with
`docker logs lincx-mcp | jq 'select(.user_id == "salah")'`. Add Loki/Datadog
later if needed.

### 3.12 Add persistence only when (concrete triggers)

- A client asks for an audit report → Postgres
- SOC2/compliance conversation starts → Postgres
- Want a usage analytics dashboard → Postgres or Metabase on log files
- Incident with no log reconstruction path → Postgres

Until then, stdout is enough.

---

## 4. Plugin marketplace

### 4.1 Repo layout

```
lincx-marketplace/
├── .claude-plugin/marketplace.json    # lists all plugins
├── plugins/
│   ├── zone-debugger/
│   │   └── .claude-plugin/plugin.json
│   ├── template-workbench/
│   ├── reporting-analyst/
│   └── _shared/                       # shared skills/docs
└── README.md
```

Install:
```
/plugin marketplace add lincx/lincx-marketplace
/plugin install zone-debugger
```

Client distribution: separate marketplace repo with curated subset, or a
`clientFacing: true` flag in plugin.json that an install script respects.

### 4.2 Plugin: `zone-debugger`

**MCP dependencies (declared in plugin.json):**
- `lincx-mcp` (remote, HTTP)
- `playwright` (local, npx — runs on user's machine)

**Why client-side Playwright:** can hit internal/staging/VPN'd client sites,
uses user's cookies, looks like a real browser to bot detection, no RAM cost
for you, no SSRF risk on your infra.

**Contents:**
- `skills/debug-zone-load.md` — orchestrator for "debug zone X" prompts.
  Calls `zone_load_trace`, presents entity tree, follows up with
  `zone_top_ads` for matching debug.
- `skills/debug-zone-from-url.md` — URL debugging workflow (see 4.2.1).
- `skills/explain-targeting.md` — reference doc for targeting questions.
- `agents/zone-investigator.md` — subagent for deep investigations
  (separate context window).
- `commands/zone.md` — `/zone <id>` shortcut.
- `hooks/block-writes.json` — PreToolUse hook that blocks any write tool
  in this plugin (debugging is read-only).

**4.2.1 URL debug skill outline:**

```markdown
# debug-zone-from-url

When the user gives you a URL to debug a Lincx ad slot:

1. `playwright.browser_navigate` to the URL
2. `playwright.browser_wait_for` networkidle
3. `playwright.browser_network_requests` — filter for:
   - /load or /load.js (script presence)
   - /api/ads/ad (zoneId in query params)
4. Extract zoneId from request URLs
5. `playwright.browser_console_messages` (capture errors)
6. `playwright.browser_take_screenshot`
7. For each detected zoneId, call `lincx.zone_load_trace`
8. Correlate:
   - Did /load fire? If not → script not installed correctly
   - Did /api/ads/ad return ads? Cross-ref with matching debug
   - CSP/CORS errors blocking the script?
   - Does rendered DOM contain expected ad markup?
9. Report findings with screenshot

If a consent banner blocks the script, `playwright.browser_click` to
accept, then re-check.
```

If the LLM proves unreliable at following 9 steps, fallback options:
- Slash command running a deterministic script via a hook
- Thin server-side composite `correlate_zone_debug({ url, zoneId,
  networkRequests, consoleErrors })` that takes pre-extracted Playwright
  data and centralizes the correlation logic

### 4.3 Plugin: `template-workbench`

- `skills/template-coding.md` — fetch current → propose changes →
  `render_template` with synthetic ads → preview → optionally render against
  real zone → require explicit "save" before any write.
- `skills/template-render-review.md` — iterate-on-render loop. Documents
  template DSL/format.
- `agents/template-renderer.md` — isolated context for tweak-render loop.
- `hooks/elicit-render-context.json` — UserPromptSubmit hook asking
  "which zone?" / "live or fixtures?" before kicking off.
- `hooks/confirm-template-write.json` — PreToolUse on `update_template_draft`,
  hard stop requiring `engineer` role + explicit confirmation phrase.

### 4.4 Plugin: `reporting-analyst`

- `skills/report-from-natural-language.md` — translates NL to `report_query`.
  Step 1: `event_stats_keys` to ground. Step 2: pick `dimensionSetId`.
  Step 3: `report_query`. Step 4: analyze and answer.
- `skills/metric-glossary.md` — internal definitions (CTR, viewability,
  eCPM, etc.) so the LLM doesn't hallucinate.
- `agents/numbers-analyst.md` — multi-step analyses (period compares,
  segmentation, anomaly hunting).
- `commands/report.md` — `/report <natural language>` one-shot.

### 4.5 Plugin: `_shared`

Reference docs every other plugin loads:
- `lincx-entity-model.md` — canonical diagram (network → publisher →
  channel → site → zone → ad-group → ads → creatives + template).
- `roles.md` — how role gating works.
- `qa-elicitation.md` — "ask before you act" patterns.

### 4.6 Hooks taxonomy

| Hook              | When                          | Purpose                                   |
| ----------------- | ----------------------------- | ----------------------------------------- |
| `SessionStart`    | Plugin loads                  | Restore active network from preferences   |
| `UserPromptSubmit`| Before LLM sees prompt        | Inject active network context             |
| `PreToolUse`      | Before tool dispatch          | Role check, confirmation, intent log      |
| `PostToolUse`     | After tool returns            | Audit on writes, notify on errors         |
| `Stop`            | End of session                | Summarize writes made this session        |

### 4.7 QA / elicitation pattern

Before destructive or expensive actions, ask 1–3 tight questions
(single-select where possible):

- Template render: "Render with: (a) live ads from a zone, (b) fixtures,
  (c) ads I'll paste?"
- Ambiguous zone debug: "I see 3 zones matching 'homepage_top'. Which network?"
- Report request: "Time range: (a) yesterday, (b) last 7d, (c) last 30d,
  (d) custom?"

Before reads, no questions — just go. Friction kills client/manager adoption.

---

## 5. Build order

1. **Harden lincx-mcp Tier 1 + `zone_load_trace`.** Nothing else works
   without this. ~1 week.
2. **Ship `zone-debugger` plugin** with skill + `/zone` command. Get
   internal team using it. Iterate entity-model docs from real questions.
   ~1 week.
3. **Add Playwright integration to `zone-debugger`** (URL debugging skill).
   ~3 days.
4. **Add `report_query` + `reporting-analyst` plugin.** Highest leverage
   for managers/clients. ~1 week.
5. **Add `render_template` + `template-workbench`.** Hardest one — sandbox,
   asset loading, zone-ad fetching. ~2 weeks.
6. **Tier 3 writes + role gating + audit hooks.** Only after read-side is
   battle-tested. ~1 week.

---

## 6. Versioning & extension

- **Semver lincx-mcp.** Plugins pin major version.
- **Tool versioning** by suffix on incompatible changes:
  `zone_load_trace` → `zone_load_trace_v2`. Keep old for one minor cycle.
- **New SaaS endpoints** → new tool file in the right `tools/` folder.
  Composites are where you spend design time; primitives are mechanical.
- **New plugins** only when a clear new domain emerges. Extend existing
  plugins until they bulge. Likely future domains: `publisher-onboarding`,
  `campaign-builder`, `qa-cypress-runner`.

---

## 7. Testing

- **Unit tests** on composites with mocked HTTP. Composites are pure logic
  — most coverage lives here.
- **Contract tests** hitting Lincx staging per tool. Run on PR.
- **MCP protocol tests** with `@modelcontextprotocol/inspector`. Manual
  but invaluable during dev.
- **End-to-end** scripted Claude Code sessions against staging MCP for
  the top 10 user prompts ("debug zone X", "yesterday's report", etc.).

---

## 8. Deployment

- **Container:** single Node, multi-stage build, ~100MB image.
- **Coolify:** new service, Traefik route, env vars from §3.2.
- **Health check:** `/health` pings Lincx API.
- **Scaling:** stateless, horizontal scale trivial. Start with one replica.
- **No Playwright container** — runs client-side via plugin.

---

## 9. Open decisions

- Hostname: `mcp.zakadev.com` (personal infra) vs Lincx-internal subdomain?
- Template sandbox: Node `vm` module vs headless Chromium tab? Chromium is
  more accurate but heavier; `vm` is lighter but won't catch DOM-render
  bugs.
- Client distribution: separate marketplace repo per audience, or single
  repo with install-time filtering?

---

## 10. What done looks like for v1

- One HTTPS endpoint with ~30–40 tools across 3 tiers.
- Two heavy composites (`zone_load_trace`, `render_template`) doing the
  real work.
- Three plugins shipped: `zone-debugger`, `template-workbench`,
  `reporting-analyst`.
- Internal team using daily, replacing 3+ context-switches per debug
  session with one chat.
- At least one client onboarded to `reporting-analyst` for self-serve
  reporting.
- Stateless containers, stdout logs, no DB, no Redis. Add only when a
  concrete trigger fires.
