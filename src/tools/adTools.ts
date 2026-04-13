/**
 * tools/adTools.ts
 *
 * list_ads        — GET /api/ads (paginated)
 * get_ad          — GET /api/ads/{id}
 * get_ad_parents  — GET /api/ads/{id}/parents
 * get_zone_ads    — GET /api/ads/ad (ad-serving endpoint)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, stripListItems } from "../services/workApi.js";

export function registerAdTools(server: McpServer, getSessionId: () => string | null): void {

  // ── list_ads ─────────────────────────────────────────────────────────────────
  server.registerTool("list_ads", {
    title: "List Ads",
    description: `List all ads on the active network with limit/offset pagination.`,
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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/ads", { params: { limit, offset } });
      const text = JSON.stringify(stripListItems(data), null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
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
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/ads/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_ad_parents ───────────────────────────────────────────────────────────
  server.registerTool("get_ad_parents", {
    title: "Get Ad Parents",
    description: `Fetch the parent hierarchy of an ad (ad-group → campaign → network).`,
    inputSchema: z.object({
      id: z.string().describe("Ad ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/ads/${id}/parents`);
      const text = JSON.stringify(data, null, 2);
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
  }, async ({ zoneId, adFeedCount, geoState, geoCity, geoIP, geoPostal, geoCountry, scoreKey }) => {
    const sessionId = getSessionId();
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
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
