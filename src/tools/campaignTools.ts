/**
 * tools/campaignTools.ts
 *
 * list_campaigns        — GET /api/campaigns (paginated)
 * get_campaign          — GET /api/campaigns/{id}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape, includeShape, getEntityWithIncludes } from "./_shared.js";

export function registerCampaignTools(server: McpServer): void {

  // ── list_campaigns ───────────────────────────────────────────────────────────
  server.registerTool("list_campaigns", {
    title: "List Campaigns",
    description: `List campaigns on the active network with limit/offset pagination. Pass advertiserId to enumerate one advertiser's campaigns exhaustively; without it, the whole network is listed.`,
    inputSchema: z.object({
      advertiserId: z.string().optional().describe("Only campaigns for this advertiser"),
      ...paginationShape,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields, advertiserId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { limit, offset };
      if (advertiserId !== undefined) params.advertiserId = advertiserId;
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/campaigns", { params });
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
      return { content: [{ type: "text" as const, text: fitEntityToText(data) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
