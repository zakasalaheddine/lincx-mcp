/**
 * tools/templateTools.ts
 *
 * list_templates    — GET /api/templates (paginated)
 * get_template      — GET /api/templates/{id}
 * get_template_versions — GET /api/templates/{id}/versions
 * get_template_version  — GET /api/templates/{id}/versions/{version}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, stripListItems, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape, includeShape, getEntityWithIncludes } from "./_shared.js";

export function registerTemplateTools(server: McpServer): void {

  // ── list_templates ──────────────────────────────────────────────────────────
  server.registerTool("list_templates", {
    title: "List Templates",
    description: `List all ad templates available on the active network.

Returns an array of template objects. Each template has an id, name, and metadata.
Use 'get_template' to fetch the full HTML + CSS source of a specific template.

Params:
  - limit: max results (1–100, default 25)
  - offset: pagination offset (default 0)
  - fields: extra item fields to include beyond { id, name } plus status fields`,
    inputSchema: z.object({ ...paginationShape }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/templates", { params: { limit, offset } });
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_template ────────────────────────────────────────────────────────────
  server.registerTool("get_template", {
    title: "Get Template",
    description: `Fetch full details of a single template by ID, including its HTML and CSS source.

Returns the template object with id, name, html, css, creativeAssetGroupId, and version info.`,
    inputSchema: z.object({
      id: z.string().describe("Template ID"),
      ...includeShape,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await getEntityWithIncludes(v.session, "/api/templates", id, include);
      const text = JSON.stringify(data);
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
      const text = JSON.stringify(stripListItems(data));
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
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
