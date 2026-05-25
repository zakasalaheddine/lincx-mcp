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
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape } from "./_shared.js";

export function registerCreativeAssetGroupTools(server: McpServer): void {

  // ── list_creative_asset_groups ──────────────────────────────────────────────
  server.registerTool("list_creative_asset_groups", {
    title: "List Creative Asset Groups",
    description: `List all creative asset groups on the active network.

Creative asset groups define the ad data schema — the fields (title, image URL, click URL, etc.)
that ads must provide when rendered in a template.

Each template is linked to exactly one creative asset group.

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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/creative-asset-groups", { params: { limit, offset } });
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
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

Use this with 'get_template' to understand what mock ad data a template expects.`,
    inputSchema: z.object({
      id: z.string().describe("Creative asset group ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/creative-asset-groups/${id}`);
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
