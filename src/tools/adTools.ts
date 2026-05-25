/**
 * tools/adTools.ts
 *
 * list_ads        — GET /api/ads (paginated)
 * get_ad          — GET /api/ads/{id}
 * get_zone_ads    — GET /api/ads/ad (ad-serving endpoint)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape, includeShape, getEntityWithIncludes } from "./_shared.js";

export function registerAdTools(server: McpServer): void {

  // ── list_ads ─────────────────────────────────────────────────────────────────
  server.registerTool("list_ads", {
    title: "List Ads",
    description: `List all ads on the active network with limit/offset pagination.`,
    inputSchema: z.object({ ...paginationShape }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/ads", { params: { limit, offset } });
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_ad ───────────────────────────────────────────────────────────────────
  server.registerTool("get_ad", {
    title: "Get Ad",
    description: `Fetch full configuration of an ad by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Ad ID"),
      ...includeShape,
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, include }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await getEntityWithIncludes(v.session, "/api/ads", id, include);
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone_ads ─────────────────────────────────────────────────────────────
  server.registerTool("get_zone_ads", {
    title: "Get Zone Ads",
    description: `Calls the ad-serving endpoint for a zone. Returns the ads that would be shown and the template they render into ({ ads, template }).`,
    inputSchema: z.object({
      zoneId: z.string().describe("Zone ID to fetch serving ads for"),
      adFeedCount: z.number().int().optional(),
      geoState: z.string().optional(),
      geoCity: z.string().optional(),
      geoIP: z.string().optional(),
      geoPostal: z.string().optional(),
      geoCountry: z.string().optional(),
      scoreKey: z.string().optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ zoneId, adFeedCount, geoState, geoCity, geoIP, geoPostal, geoCountry, scoreKey }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const params: Record<string, unknown> = { zoneId };
      if (adFeedCount !== undefined) params.adFeedCount = adFeedCount;
      if (geoState !== undefined) params.geoState = geoState;
      if (geoCity !== undefined) params.geoCity = geoCity;
      if (geoIP !== undefined) params.geoIP = geoIP;
      if (geoPostal !== undefined) params.geoPostal = geoPostal;
      if (geoCountry !== undefined) params.geoCountry = geoCountry;
      if (scoreKey !== undefined) params.scoreKey = scoreKey;

      const data = await workApiRequest<unknown>(v.session, "GET", "/api/ads/ad", { params });
      const text = JSON.stringify(data);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
