/**
 * tools/advertiserTools.ts
 *
 * list_advertisers — GET /api/advertisers
 * get_advertiser   — GET /api/advertisers/{id}
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, fitEntityToText, buildListEnvelope, listEnvelopeToText } from "../services/workApi.js";
import { paginationShape } from "./_shared.js";

export function registerAdvertiserTools(server: McpServer): void {

  // ── list_advertisers ─────────────────────────────────────────────────────────
  server.registerTool("list_advertisers", {
    title: "List Advertisers",
    description: `List all advertisers on the active network with limit/offset pagination.`,
    inputSchema: z.object({ ...paginationShape }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit, offset, fields }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", "/api/advertisers", { params: { limit, offset } });
      const text = listEnvelopeToText(buildListEnvelope(data, { limit, offset, fields }));
      return { content: [{ type: "text" as const, text }] };
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
  }, async ({ id }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/advertisers/${id}`);
      return { content: [{ type: "text" as const, text: fitEntityToText(data) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
