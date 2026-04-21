/**
 * tools/zoneTools.ts
 *
 * list_zones          — GET /api/zones (paginated)
 * get_zone            — GET /api/zones/{id}
 * get_zone_parents    — GET /api/zones/{id}/parents
 * get_zone_report     — GET /api/zones/{id}/report
 * zone_load_trace     — composite: fan-out diagnostic (added in Task 5)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded, stripListItems } from "../services/workApi.js";

export function registerZoneTools(server: McpServer): void {

  // ── list_zones ──────────────────────────────────────────────────────────────
  server.registerTool("list_zones", {
    title: "List Zones",
    description: `List all zones on the active network. Use get_zone to fetch full config of a specific zone.`,
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
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/zones", { params: { limit, offset } });
      const text = JSON.stringify(stripListItems(data), null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone ────────────────────────────────────────────────────────────────
  server.registerTool("get_zone", {
    title: "Get Zone",
    description: `Fetch full configuration of a zone by ID.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone_parents ────────────────────────────────────────────────────────
  server.registerTool("get_zone_parents", {
    title: "Get Zone Parents",
    description: `Fetch the parent hierarchy of a zone: site → channel → publisher → network.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}/parents`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── get_zone_report ─────────────────────────────────────────────────────────
  server.registerTool("get_zone_report", {
    title: "Get Zone Report",
    description: `Fetch timeseries report data for a zone.`,
    inputSchema: z.object({
      id: z.string().describe("Zone ID"),
      resolution: z.enum(["day", "hour"]).default("day"),
      startDate: z.string().describe("ISO date e.g. 2026-01-01"),
      endDate: z.string().describe("ISO date e.g. 2026-01-31"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id, resolution, startDate, endDate }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/zones/${id}/report`, { params: { resolution, startDate, endDate } });
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });

  // ── zone_load_trace ─────────────────────────────────────────────────────────
  server.registerTool("zone_load_trace", {
    title: "Zone Load Trace",
    description: `Fan-out zone diagnostic tool. Given a zone ID, makes parallel API calls to fetch:
- Zone config and parent hierarchy (site → channel → publisher → network)
- Ads that would serve in this zone (via the ad-serving endpoint)
- Debug data explaining which ad-groups matched and which were rejected
- Full details for each matched ad
- The template the zone uses

Returns one structured blob for LLM analysis plus a human-readable 'summary' field.

Use this first when debugging why a zone is or isn't serving ads.`,
    inputSchema: z.object({
      zoneId: z.string().describe("Zone ID to trace"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ zoneId }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
    const session = v.session;

    try {
      // Round 1: 4 parallel calls
      const [zoneResp, parentsResp, adsResp, debugResp] = await Promise.all([
        workApiRequest<Record<string, unknown>>(session, "GET", `/api/zones/${zoneId}`),
        workApiRequest<Record<string, unknown>>(session, "GET", `/api/zones/${zoneId}/parents`),
        workApiRequest<Record<string, unknown>>(session, "GET", "/api/ads/ad", { params: { zoneId } })
          .catch((): Record<string, unknown> => ({ error: "ad-serving endpoint unavailable" })),
        workApiRequest<Record<string, unknown>>(session, "GET", "/api/ads/ad/debug", { params: { zoneId } })
          .catch((): Record<string, unknown> => ({ error: "debug endpoint unavailable" })),
      ]);

      // Extract matched ad IDs from serving response
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adsData = (adsResp as any).data ?? adsResp;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchedAds: Array<{ id: string }> = Array.isArray((adsData as any).ads)
        ? (adsData as any).ads
        : [];

      // Round 2: fetch full ad details in parallel (fail-safe per ad)
      const adDetails = await Promise.all(
        matchedAds.map(ad =>
          workApiRequest<Record<string, unknown>>(session, "GET", `/api/ads/${ad.id}`)
            .catch(() => ({ id: ad.id, error: "fetch failed" }))
        )
      );

      // Round 3: fetch zone template (from serving response, if present)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const templateId: string | undefined = (adsData as any).template?.id ?? (adsData as any).templateId;
      const templateDetails = templateId
        ? await workApiRequest<Record<string, unknown>>(session, "GET", `/api/templates/${templateId}`)
            .catch(() => ({ id: templateId, error: "fetch failed" }))
        : null;

      // Build human-readable summary
      const matchCount = matchedAds.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const zoneName: string = String(((zoneResp as any).data ?? zoneResp as any)?.name ?? zoneId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const debugData = (debugResp as any).data ?? debugResp;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rejectedCount: number = Array.isArray((debugData as any).rejected) ? (debugData as any).rejected.length : 0;
      const summary = `Zone "${zoneName}" (${zoneId}): ${matchCount} ad(s) matched, ${rejectedCount} rejected.${templateId ? ` Template: ${templateId}.` : " No template detected."}`;

      const result = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        zone: (zoneResp as any).data ?? zoneResp,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parents: (parentsResp as any).data ?? parentsResp,
        matching: {
          matched: matchedAds,
          debug: debugData,
        },
        ads: adDetails,
        template: templateDetails,
        summary,
      };

      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
