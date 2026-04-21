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
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, stripListItems } from "../services/workApi.js";

export function registerTemplateTools(server: McpServer): void {

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
  }, async ({ limit, offset }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/templates", { params: { limit, offset } });
      const text = JSON.stringify(stripListItems(data), null, 2);
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
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

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
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}/versions`);
      const text = JSON.stringify(stripListItems(data), null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
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
  }, async ({ id, version }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/templates/${id}/versions/${version}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
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
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
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

  // ── render_template ─────────────────────────────────────────────────────────
  server.registerTool("render_template", {
    title: "Render Template",
    description: `Fetch a template's HTML + CSS source and return it alongside mock ad data that conforms to the template's creative asset group schema.

Does NOT inject mock ads into the HTML — returns the raw HTML + CSS and the mock ad payload separately, so the engineer can wire them together locally.

Params:
  - templateId: ID of the template to render
  - version: specific version number to render (omit for latest)
  - mockAds: optional array of ad objects; if omitted, 2 placeholders are auto-generated from the creative asset group schema`,
    inputSchema: z.object({
      templateId: z.string().describe("Template ID"),
      version: z.number().int().min(1).optional().describe("Version number (omit for latest)"),
      mockAds: z.array(z.record(z.unknown())).optional().describe("Override auto-generated mock ads"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ templateId, version, mockAds }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cagData = (cagResp as any).data ?? cagResp;

      // Step 3: Generate mock ads if not provided
      const adsToInject = mockAds ?? generateMockAds(cagData, 2);

      // Step 4: Return HTML + CSS + mock data used
      const result = {
        templateId,
        version: version ?? "latest",
        creativeAssetGroupId: cagId,
        html,
        css,
        mockAdsUsed: adsToInject,
        note: "Paste the html and css into a local file to preview. The mockAdsUsed shows the data shape your template expects.",
      };

      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateMockAds(cagData: Record<string, unknown>, count: number): Record<string, unknown>[] {
  // Creative asset groups may return fields as an array or as a schema object.
  // Try both shapes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields: Array<{ name?: string; type?: string; key?: string }> =
    Array.isArray(cagData.fields) ? cagData.fields as Array<{ name?: string; type?: string; key?: string }> :
    Array.isArray(cagData.assets) ? cagData.assets as Array<{ name?: string; type?: string; key?: string }> :
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Array.isArray((cagData.schema as any)?.fields) ? (cagData.schema as any).fields as Array<{ name?: string; type?: string; key?: string }> :
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
