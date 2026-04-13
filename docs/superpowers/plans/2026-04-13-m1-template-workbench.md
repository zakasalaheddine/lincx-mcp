# Template Workbench (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 8 MCP tools for reading templates, reading creative asset groups, and rendering templates with mock ad data — no writes, no sandbox.

**Architecture:** Extend `src/tools/` with two new files following the exact same pattern as `authTools.ts` / `networkTools.ts`. Register both in `src/index.ts`. No new services needed — all API calls go through `workApiRequest()` in `services/workApi.ts`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, native `fetch` via `workApiRequest`

**Spec:** `docs/superpowers/specs/2026-04-13-lincx-mcp-design.md`

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/tools/templateTools.ts` | list_templates, get_template, get_template_versions, get_template_version, get_template_parents, render_template |
| Create | `src/tools/creativeAssetGroupTools.ts` | list_creative_asset_groups, get_creative_asset_group |
| Modify | `src/index.ts` | Import + register both new tool files |

No new types needed — all responses are typed as `unknown` and serialized directly to JSON.

---

## Existing Patterns to Follow

Every tool in this codebase follows this exact shape. Do not deviate:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerXxxTools(server: McpServer, getSessionId: () => string | null): void {
  server.registerTool("tool_name", {
    title: "Human Title",
    description: `What this tool does and what it returns.`,
    inputSchema: z.object({ /* never include networkId */ }).strict(),
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

In `src/index.ts`, register like this (see existing `registerAuthTools` and `registerNetworkTools` calls):
```ts
import { registerTemplateTools } from "./tools/templateTools.js";
import { registerCreativeAssetGroupTools } from "./tools/creativeAssetGroupTools.js";
// ...
registerTemplateTools(server, getSessionId);
registerCreativeAssetGroupTools(server, getSessionId);
```

Build after every change: `npm run build` — Claude Code runs `dist/index.js`, not source.

---

## Task 1: `list_templates` and `get_template`

**Files:**
- Create: `src/tools/templateTools.ts`

- [ ] **Step 1: Create `src/tools/templateTools.ts` with `list_templates` and `get_template`**

```ts
/**
 * tools/templateTools.ts
 *
 * list_templates    — GET /api/templates (paginated)
 * get_template      — GET /api/templates/{id}
 * get_template_versions — GET /api/templates/{id}/versions
 * get_template_version  — GET /api/templates/{id}/versions/{version}
 * get_template_parents  — GET /api/templates/{id}/parents
 * render_template   — composite: fetch template + CAG → inject mock ads → return HTML+CSS
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerTemplateTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_templates ──────────────────────────────────────────────────────────
  server.registerTool("list_templates", {
    title: "List Templates",
    description: `List all ad templates available on the active network.

Returns an array of template objects. Each template has an id, name, and metadata.
Use 'get_template' to fetch the full HTML + CSS source of a specific template.

Params:
  - limit: max results (1–100, default 20)
  - offset: pagination offset (default 0)`,
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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/templates", { params: { limit, offset } });
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_template ────────────────────────────────────────────────────────────
  server.registerTool("get_template", {
    title: "Get Template",
    description: `Fetch full details of a single template by ID, including its HTML and CSS source.

Returns the template object with id, name, html, css, creativeAssetGroupId, and version info.
Use 'render_template' to preview it with mock ad data.`,
    inputSchema: z.object({
      id: z.string().describe("Template ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: no TypeScript errors, `dist/tools/templateTools.js` created.

- [ ] **Step 3: Register in `src/index.ts`**

Add after the existing imports (around line 24):
```ts
import { registerTemplateTools } from "./tools/templateTools.js";
```

Add after existing `registerNetworkTools(server, getSessionId);` call:
```ts
registerTemplateTools(server, getSessionId);
```

- [ ] **Step 4: Build again and verify**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add src/tools/templateTools.ts src/index.ts
git commit -m "feat: add list_templates and get_template tools"
```

---

## Task 2: `get_template_versions`, `get_template_version`, `get_template_parents`

**Files:**
- Modify: `src/tools/templateTools.ts` (add 3 more tools inside the same `registerTemplateTools` function)

- [ ] **Step 1: Add `get_template_versions` inside `registerTemplateTools`**

Append before the closing `}` of `registerTemplateTools`:

```ts
  // ── get_template_versions ───────────────────────────────────────────────────
  server.registerTool("get_template_versions", {
    title: "Get Template Versions",
    description: `List all saved versions of a template.

Returns version numbers, timestamps, and who created each version.
Use 'get_template_version' to fetch the HTML + CSS of a specific version.`,
    inputSchema: z.object({
      id: z.string().describe("Template ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}/versions`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_template_version ────────────────────────────────────────────────────
  server.registerTool("get_template_version", {
    title: "Get Template Version",
    description: `Fetch the HTML + CSS source of a specific version of a template.

Use 'get_template_versions' first to see available version numbers.`,
    inputSchema: z.object({
      id: z.string().describe("Template ID"),
      version: z.number().int().min(1).describe("Version number"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, version }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}/versions/${version}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_template_parents ────────────────────────────────────────────────────
  server.registerTool("get_template_parents", {
    title: "Get Template Parents",
    description: `Fetch the parent entities of a template (e.g. which network it belongs to).`,
    inputSchema: z.object({
      id: z.string().describe("Template ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}/parents`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add src/tools/templateTools.ts
git commit -m "feat: add get_template_versions, get_template_version, get_template_parents tools"
```

---

## Task 3: `list_creative_asset_groups` and `get_creative_asset_group`

**Files:**
- Create: `src/tools/creativeAssetGroupTools.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Create `src/tools/creativeAssetGroupTools.ts`**

```ts
/**
 * tools/creativeAssetGroupTools.ts
 *
 * list_creative_asset_groups — GET /api/creative-asset-groups (paginated)
 * get_creative_asset_group   — GET /api/creative-asset-groups/{id}
 *
 * Creative asset groups define the ad data schema (the fields ads must provide).
 * Each template is associated with exactly one creative asset group.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerCreativeAssetGroupTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_creative_asset_groups ──────────────────────────────────────────────
  server.registerTool("list_creative_asset_groups", {
    title: "List Creative Asset Groups",
    description: `List all creative asset groups on the active network.

Creative asset groups define the ad data schema — the fields (title, image URL, click URL, etc.)
that ads must provide when rendered in a template.

Each template is linked to exactly one creative asset group.

Params:
  - limit: max results (1–100, default 20)
  - offset: pagination offset (default 0)`,
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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/creative-asset-groups", { params: { limit, offset } });
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_creative_asset_group ────────────────────────────────────────────────
  server.registerTool("get_creative_asset_group", {
    title: "Get Creative Asset Group",
    description: `Fetch a creative asset group by ID, including its full field schema.

The schema defines what data fields ads must provide when rendered into a template
linked to this group (e.g. title: string, imageUrl: string, clickUrl: string).

Use this before calling 'render_template' to understand what mock ad data to provide.`,
    inputSchema: z.object({
      id: z.string().describe("Creative asset group ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/creative-asset-groups/${id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

- [ ] **Step 2: Register in `src/index.ts`**

Add import:
```ts
import { registerCreativeAssetGroupTools } from "./tools/creativeAssetGroupTools.js";
```

Add registration after `registerTemplateTools`:
```ts
registerCreativeAssetGroupTools(server, getSessionId);
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add src/tools/creativeAssetGroupTools.ts src/index.ts
git commit -m "feat: add list_creative_asset_groups and get_creative_asset_group tools"
```

---

## Task 4: `render_template` composite

**Files:**
- Modify: `src/tools/templateTools.ts` (add `render_template` inside `registerTemplateTools`)

`render_template` calls the API twice (template + creative asset group), generates mock ads from the CAG schema, injects them into the template, and returns HTML + CSS.

The mock ad generation reads field definitions from the creative asset group schema. For each field, it generates a sensible placeholder value based on the field name/type. The exact schema shape must be confirmed against the real API — the implementation handles both a `fields` array and a `schema` object shape.

- [ ] **Step 1: Add `render_template` inside `registerTemplateTools` (before the closing `}`)**

```ts
  // ── render_template ─────────────────────────────────────────────────────────
  server.registerTool("render_template", {
    title: "Render Template",
    description: `Render a template with mock ad data and return the raw HTML + CSS.

Fetches the template source and its linked creative asset group schema,
generates placeholder ad data that conforms to the schema, injects it into
the template, and returns the result.

The engineer can paste the returned HTML into a local browser to preview it.
No sandbox, no screenshot, no asset fetching.

Params:
  - templateId: ID of the template to render
  - version: specific version number to render (omit for latest)
  - mockAds: optional array of ad objects to inject; if omitted, 2 placeholders are auto-generated from the creative asset group schema`,
    inputSchema: z.object({
      templateId: z.string().describe("Template ID"),
      version: z.number().int().min(1).optional().describe("Version number (omit for latest)"),
      mockAds: z.array(z.record(z.unknown())).optional().describe("Override auto-generated mock ads"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ templateId, version, mockAds }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      // Step 1: Fetch template (latest or specific version)
      const templatePath = version
        ? `/api/templates/${templateId}/versions/${version}`
        : `/api/templates/${templateId}`;
      const templateResp = await workApiRequest<Record<string, unknown>>(v.session, "GET", templatePath);

      // Unwrap { data: { ... } } envelope if present
      const templateData = (templateResp as any).data ?? templateResp;
      const html: string = String(templateData.html ?? templateData.htmlTemplate ?? "");
      const css: string = String(templateData.css ?? templateData.cssTemplate ?? "");
      const cagId: string = String(
        templateData.creativeAssetGroupId ??
        templateData.creative_asset_group_id ??
        templateData.assetGroupId ?? ""
      );

      if (!cagId) {
        return { content: [{ type: "text" as const, text: "Error: Template has no linked creative asset group. Cannot generate mock data." }] };
      }

      // Step 2: Fetch creative asset group for schema
      const cagResp = await workApiRequest<Record<string, unknown>>(v.session, "GET", `/api/creative-asset-groups/${cagId}`);
      const cagData = (cagResp as any).data ?? cagResp;

      // Step 3: Generate mock ads if not provided
      const adsToInject = mockAds ?? generateMockAds(cagData, 2);

      // Step 4: Return HTML + CSS + mock data (no server-side injection — engineer reviews and applies locally)
      const result = {
        templateId,
        version: version ?? "latest",
        creativeAssetGroupId: cagId,
        html,
        css,
        mockAdsUsed: adsToInject,
        note: "Paste the html and css into a local file to preview. The mockAdsUsed shows the data shape your template expects.",
      };

      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateMockAds(cagData: Record<string, unknown>, count: number): Record<string, unknown>[] {
  // Creative asset groups may return fields as an array or as a schema object.
  // Try both shapes.
  const fields: Array<{ name: string; type?: string; key?: string }> =
    Array.isArray(cagData.fields) ? cagData.fields :
    Array.isArray(cagData.assets) ? cagData.assets :
    Array.isArray((cagData.schema as any)?.fields) ? (cagData.schema as any).fields :
    [];

  const ads: Record<string, unknown>[] = [];
  for (let i = 1; i <= count; i++) {
    const ad: Record<string, unknown> = { id: `mock-ad-${i}` };
    for (const field of fields) {
      const key: string = field.name ?? field.key ?? "field";
      const type: string = (field.type ?? "string").toLowerCase();
      if (key.toLowerCase().includes("url") || key.toLowerCase().includes("image")) {
        ad[key] = `https://via.placeholder.com/300x250?text=Ad+${i}`;
      } else if (key.toLowerCase().includes("click") || key.toLowerCase().includes("link")) {
        ad[key] = `https://example.com/ad-${i}`;
      } else if (type === "number" || type === "integer") {
        ad[key] = i;
      } else {
        ad[key] = `Mock ${key} ${i}`;
      }
    }
    ads.push(ad);
  }
  return ads;
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean build.

- [ ] **Step 3: Smoke test (requires running server + auth session)**

```bash
npm start
# In Claude Code, after auth_login and network selection:
# Call render_template with a known templateId
# Expected: JSON with html, css, mockAdsUsed fields
```

- [ ] **Step 4: Commit**

```bash
git add src/tools/templateTools.ts
git commit -m "feat: add render_template composite tool"
```

---

## Task 5: Final build verification and CLAUDE.md update

- [ ] **Step 1: Full clean build**

```bash
npm run build 2>&1
```

Expected: zero errors, zero warnings.

- [ ] **Step 2: Update CLAUDE.md — add M1 tools to known tools list**

In `CLAUDE.md`, find or add a "Implemented Tools" section and document:

```markdown
## Implemented Tools

### Auth (already shipped)
- `auth_login` — returns browser login URL
- `auth_status` — check session state
- `auth_logout` — destroy session

### Networks (already shipped)
- `network_list` — list available networks
- `network_switch` — change active network
- `network_refresh` — re-fetch networks from API

### Templates (M1)
- `list_templates` — GET /api/templates (paginated)
- `get_template` — GET /api/templates/{id} — includes HTML + CSS
- `get_template_versions` — GET /api/templates/{id}/versions
- `get_template_version` — GET /api/templates/{id}/versions/{version}
- `get_template_parents` — GET /api/templates/{id}/parents
- `render_template` — composite: fetch template + CAG schema → generate mock ads → return HTML + CSS

### Creative Asset Groups (M1)
- `list_creative_asset_groups` — GET /api/creative-asset-groups (paginated)
- `get_creative_asset_group` — GET /api/creative-asset-groups/{id} — includes field schema
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document M1 template workbench tools in CLAUDE.md"
```

---

## Open Decisions (confirm on first API hit)

1. **Template response envelope** — does `GET /api/templates/{id}` return `{ data: { html, css, creativeAssetGroupId } }` or a flat object? The `render_template` code handles both via `(resp as any).data ?? resp`.

2. **Creative asset group field shape** — does the CAG return `{ fields: [{ name, type }] }` or `{ assets: [...] }` or `{ schema: { fields: [...] } }`? The `generateMockAds` helper tries all three.

3. **`creativeAssetGroupId` field name** — the code tries `creativeAssetGroupId`, `creative_asset_group_id`, and `assetGroupId`. Confirm the actual key name and remove the fallbacks.

Once confirmed, simplify the envelope unwrapping and field-name logic to the exact shape.
