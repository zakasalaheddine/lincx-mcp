# M3 Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add M3 Reporting tools to the Lincx MCP server: dimension sets, event stats, `report_query` composite, zone report, advertisers, and experiences.

**Architecture:** Three new tool files (`reportingTools.ts`, `advertiserTools.ts`, `experienceTools.ts`) registered in `index.ts`. All tools follow the same pattern: `validateSession` → `workApiRequest` → `truncateIfNeeded` → return JSON. `report_query` is the only composite — it delegates to `GET /api/reports/{dimensionSetId}` with date/filter params. `zone_report` lives in `reportingTools.ts` (not `zoneTools.ts`) since it is a reporting endpoint.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Zod, `workApiRequest()` utility, NodeNext ESM (`.js` imports)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/tools/reportingTools.ts` | Create | `list_dimension_sets`, `get_dimension_set`, `get_event_stats_keys`, `zone_report`, `report_query` |
| `src/tools/advertiserTools.ts` | Create | `list_advertisers`, `get_advertiser` |
| `src/tools/experienceTools.ts` | Create | `list_experiences`, `get_experience` |
| `src/index.ts` | Modify | Import + register all 3 new tool files |
| `CLAUDE.md` | Modify | Add M3 tool documentation under "Implemented Tools" |

---

## Critical Rules (never violate)

- Never `console.log` — use `console.error` only (stdout = wire protocol)
- Never accept `networkId` as a tool parameter — injected from session by `workApiRequest()`
- Always call `validateSession(sessionId)` before any API call
- Always wrap list and large single-item responses with `truncateIfNeeded()`
- Always use `.strict()` on Zod schemas
- Always use `type: "text" as const` in content arrays
- All imports use `.js` extension (NodeNext ESM)

---

### Task 1: Create `src/tools/reportingTools.ts` — primitive reporting tools

**Files:**
- Create: `src/tools/reportingTools.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * tools/reportingTools.ts
 *
 * list_dimension_sets  — GET /api/dimension-sets
 * get_dimension_set    — GET /api/dimension-sets/{id}
 * get_event_stats_keys — GET /api/event-stats
 * zone_report          — GET /api/zones/{id}/report
 * report_query         — composite: GET /api/reports/{dimensionSetId}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerReportingTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_dimension_sets ──────────────────────────────────────────────────────
  server.registerTool("list_dimension_sets", {
    title: "List Dimension Sets",
    description: `List all dimension sets configured for the active network. Dimension sets define the available reporting dimensions (e.g. zone, campaign, day).`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/dimension-sets", { params: { limit, offset } });
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_dimension_set ────────────────────────────────────────────────────────
  server.registerTool("get_dimension_set", {
    title: "Get Dimension Set",
    description: `Fetch a single dimension set by ID. Returns the dimensions it contains and its configuration.`,
    inputSchema: z.object({
      id: z.string().describe("Dimension Set ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/dimension-sets/${id}`);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_event_stats_keys ─────────────────────────────────────────────────────
  server.registerTool("get_event_stats_keys", {
    title: "Get Event Stats Keys",
    description: `Fetch unique event key-value pairs collected by the active network over the last 31 days. Useful for understanding what filter keys are available when running report_query.`,
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/event-stats");
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── zone_report ──────────────────────────────────────────────────────────────
  server.registerTool("zone_report", {
    title: "Zone Report",
    description: `Fetch the performance report for a specific zone. Returns impression and engagement metrics for the given date range and resolution.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
      startDate: z.string().optional().describe("ISO date string (e.g. 2026-01-01)"),
      endDate: z.string().optional().describe("ISO date string (e.g. 2026-01-31)"),
      resolution: z.enum(["day", "hour"]).default("day"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, startDate, endDate, resolution }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { resolution };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;

      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}/report`, { params });
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── report_query ─────────────────────────────────────────────────────────────
  server.registerTool("report_query", {
    title: "Report Query",
    description: `Run a custom report against a dimension set. Returns time-series data aggregated by the chosen dimensions for the given date range.

Parameters:
- dimensionSetId: ID of the dimension set to report on (use list_dimension_sets to find IDs)
- startDate / endDate: ISO date strings (e.g. "2026-01-01")
- resolution: "day" (default) or "hour"
- dimensions: optional list of dimension keys to aggregate by (subset of what the dimension set supports)
- testMode: set true to query test-mode database data

Use get_event_stats_keys first to discover available filter dimensions.`,
    inputSchema: z.object({
      dimensionSetId: z.string().describe("Dimension Set ID"),
      startDate: z.string().optional().describe("ISO date (e.g. 2026-01-01)"),
      endDate: z.string().optional().describe("ISO date (e.g. 2026-01-31)"),
      resolution: z.enum(["day", "hour"]).default("day"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to aggregate by (e.g. [\"zone\", \"campaign\"])"),
      testMode: z.boolean().optional().describe("Query test-mode database data"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ dimensionSetId, startDate, endDate, resolution, dimensions, testMode }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { resolution };
      if (startDate) params.startDate = startDate;
      if (endDate) params.endDate = endDate;
      if (dimensions && dimensions.length > 0) params.d = dimensions;
      if (testMode) params["test-mode"] = true;

      const data = await workApiRequest<unknown>(v.session, "GET", `/api/reports/${dimensionSetId}`, { params });
      const text = JSON.stringify(data, null, 2);
      const rowCount = Array.isArray(data) ? data.length : (typeof data === "object" && data !== null && "rows" in data ? (data as Record<string, unknown[]>)["rows"]?.length ?? "?" : "?");
      const summary = `Report for dimension set "${dimensionSetId}" | Resolution: ${resolution} | Rows: ${rowCount}`;

      return {
        content: [{
          type: "text" as const,
          text: truncateIfNeeded(`${summary}\n\n${text}`),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

- [ ] **Step 2: Verify build passes**

Run from worktree root: `npm run build`
Expected: zero errors (TypeScript strict mode)

- [ ] **Step 3: Commit**

```bash
git add src/tools/reportingTools.ts
git commit -m "feat(m3): add reportingTools — dimension sets, event stats, zone report, report_query"
```

---

### Task 2: Create `src/tools/advertiserTools.ts`

**Files:**
- Create: `src/tools/advertiserTools.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * tools/advertiserTools.ts
 *
 * list_advertisers — GET /api/advertisers
 * get_advertiser   — GET /api/advertisers/{id}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerAdvertiserTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_advertisers ─────────────────────────────────────────────────────────
  server.registerTool("list_advertisers", {
    title: "List Advertisers",
    description: `List all advertisers on the active network with limit/offset pagination.`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/advertisers", { params: { limit, offset } });
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_advertiser ───────────────────────────────────────────────────────────
  server.registerTool("get_advertiser", {
    title: "Get Advertiser",
    description: `Fetch full details of an advertiser by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Advertiser ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/advertisers/${id}`);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: zero errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/advertiserTools.ts
git commit -m "feat(m3): add advertiserTools — list_advertisers, get_advertiser"
```

---

### Task 3: Create `src/tools/experienceTools.ts`

**Files:**
- Create: `src/tools/experienceTools.ts`

- [ ] **Step 1: Write the file**

```ts
/**
 * tools/experienceTools.ts
 *
 * list_experiences — GET /api/experiences
 * get_experience   — GET /api/experiences/{id}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerExperienceTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_experiences ─────────────────────────────────────────────────────────
  server.registerTool("list_experiences", {
    title: "List Experiences",
    description: `List all experiences on the active network with limit/offset pagination. Experiences define the ad delivery context (placement, targeting rules, etc.).`,
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/experiences", { params: { limit, offset } });
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_experience ───────────────────────────────────────────────────────────
  server.registerTool("get_experience", {
    title: "Get Experience",
    description: `Fetch full details of an experience by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Experience ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/experiences/${id}`);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(JSON.stringify(data, null, 2)) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

- [ ] **Step 2: Verify build passes**

Run: `npm run build`
Expected: zero errors

- [ ] **Step 3: Commit**

```bash
git add src/tools/experienceTools.ts
git commit -m "feat(m3): add experienceTools — list_experiences, get_experience"
```

---

### Task 4: Register M3 tools in `src/index.ts` and rebuild

**Files:**
- Modify: `src/index.ts`

The current `index.ts` imports all M1+M2 tools. Add three new imports and registrations immediately after the M2 imports.

- [ ] **Step 1: Add the three new imports**

Find the block ending with:
```ts
import { registerPublisherTools } from "./tools/publisherTools.js";
```

Add after it:
```ts
import { registerReportingTools } from "./tools/reportingTools.js";
import { registerAdvertiserTools } from "./tools/advertiserTools.js";
import { registerExperienceTools } from "./tools/experienceTools.js";
```

- [ ] **Step 2: Add the three new registrations**

Find the block of registerXxxTools calls. After the last M2 registration (`registerPublisherTools(server, getSessionId);`), add:
```ts
registerReportingTools(server, getSessionId);
registerAdvertiserTools(server, getSessionId);
registerExperienceTools(server, getSessionId);
```

- [ ] **Step 3: Rebuild and verify**

Run: `npm run build`
Expected: zero errors, `dist/` updated

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(m3): register all M3 tools in index.ts"
```

---

### Task 5: Update CLAUDE.md with M3 documentation

**Files:**
- Modify: `CLAUDE.md`

Find the last implemented tools section (should end with Publishers). Add a new section after it.

- [ ] **Step 1: Add M3 section to the "Implemented Tools" block in CLAUDE.md**

Add after the `### Publishers (M2)` section:

```markdown
### Dimension Sets (M3)
- `list_dimension_sets` — `GET /api/dimension-sets` (paginated)
- `get_dimension_set` — `GET /api/dimension-sets/{id}`

### Reporting (M3)
- `get_event_stats_keys` — `GET /api/event-stats` — unique event key-values for last 31 days
- `zone_report` — `GET /api/zones/{id}/report` (params: startDate, endDate, resolution)
- `report_query` — composite: `GET /api/reports/{dimensionSetId}` with date range, resolution, dimension filters

### Advertisers (M3)
- `list_advertisers` — `GET /api/advertisers` (paginated)
- `get_advertiser` — `GET /api/advertisers/{id}`

### Experiences (M3)
- `list_experiences` — `GET /api/experiences` (paginated)
- `get_experience` — `GET /api/experiences/{id}`
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with M3 tool documentation"
```
