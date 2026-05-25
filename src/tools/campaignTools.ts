/**
 * tools/campaignTools.ts
 *
 * list_campaigns        — GET /api/campaigns (paginated)
 * get_campaign          — GET /api/campaigns/{id}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape, includeShape, getEntityWithIncludes } from "./_shared.js";

export function registerCampaignTools(server: McpServer): void {

  // ── list_campaigns ───────────────────────────────────────────────────────────
  server.registerTool("list_campaigns", {
    title: "List Campaigns",
    description: `List all campaigns on the active network with limit/offset pagination.`,
    inputSchema: z.object({ ...paginationShape }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/campaigns", { params: { limit, offset } });
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_campaign ─────────────────────────────────────────────────────────────
  server.registerTool("get_campaign", {
    title: "Get Campaign",
    description: `Fetch full configuration of a campaign by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Campaign ID"),
      ...includeShape,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await getEntityWithIncludes(v.session, "/api/campaigns", id, include);
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
