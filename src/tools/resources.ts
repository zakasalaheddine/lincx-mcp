/**
 * tools/resources.ts
 *
 * MCP Resources (T1-3 / T4-6). Resources are pull-based reference data — the
 * client reads them by URI rather than the model spending a tool call. They are
 * NOT part of the per-request tool-schema payload, so they add no per-turn token
 * cost (resource *templates* aren't even listed in resources/list).
 *
 * Scope is deliberate:
 *  - `lincx://networks` — the one truly browse-able catalog ("what am I authed
 *    against?"). The `network_list` tool stays too; this is the discovery surface.
 *  - `lincx://{entity}/{id}` templates — let clients reference/cache an entity the
 *    model already touched, mirroring the `get_<entity>` tools.
 *
 * Workflow-input catalogs (dimension sets, event-stats keys) intentionally stay
 * as TOOLS: report_query depends on the model discovering them, which is far more
 * reliable via a planned tool call than via the model choosing to browse a resource.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { Session } from "../types.js";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError } from "../services/workApi.js";

type ResExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

async function requireSession(extra: ResExtra): Promise<{ session: Session } | { error: string }> {
  const sessionId = await resolveLincxSession(extra?.sessionId);
  if (!sessionId) return { error: "Error: Not authenticated. Use 'auth_login' first." };
  const v = await validateSession(sessionId);
  if (!v.valid || !v.session) return { error: `Error: ${v.error}` };
  return { session: v.session };
}

const json = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(value) }],
});
const plain = (uri: URL, text: string) => ({
  contents: [{ uri: uri.href, mimeType: "text/plain", text }],
});

// entity URI segment → Work API base path (mirrors the get_<entity> tools).
const ENTITY_PATHS: Record<string, string> = {
  campaign: "/api/campaigns",
  zone: "/api/zones",
  ad: "/api/ads",
  "ad-group": "/api/ad-groups",
  creative: "/api/creatives",
  template: "/api/templates",
  channel: "/api/channels",
  site: "/api/sites",
  publisher: "/api/publishers",
  advertiser: "/api/advertisers",
  experience: "/api/experiences",
  "creative-asset-group": "/api/creative-asset-groups",
  "dimension-set": "/api/dimension-sets",
};

export function registerResources(server: McpServer): void {
  // ── lincx://networks ─────────────────────────────────────────────────────────
  server.registerResource(
    "networks",
    "lincx://networks",
    {
      title: "Networks",
      description: "Networks the current session can access, plus which one is active. Use the network_switch tool to change the active network.",
      mimeType: "application/json",
    },
    async (uri, extra) => {
      const r = await requireSession(extra);
      if ("error" in r) return plain(uri, r.error);
      return json(uri, { active_network: r.session.active_network, networks: r.session.networks ?? [] });
    },
  );

  // ── lincx://{entity}/{id} ─────────────────────────────────────────────────────
  for (const [seg, basePath] of Object.entries(ENTITY_PATHS)) {
    server.registerResource(
      `${seg}-by-id`,
      new ResourceTemplate(`lincx://${seg}/{id}`, { list: undefined }),
      {
        title: `${seg} by id`,
        description: `A single ${seg} by id — equivalent to GET ${basePath}/{id}.`,
        mimeType: "application/json",
      },
      async (uri, variables, extra) => {
        const r = await requireSession(extra);
        if ("error" in r) return plain(uri, r.error);
        const id = String(variables.id);
        try {
          const data = await workApiRequest<unknown>(r.session, "GET", `${basePath}/${id}`);
          return json(uri, data);
        } catch (err) {
          return plain(uri, handleWorkApiError(err));
        }
      },
    );
  }
}
