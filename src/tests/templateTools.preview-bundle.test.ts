import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mockWorkApi } from "./helpers/mockWorkApi.js";

const api = mockWorkApi();

// Import AFTER the helper to ensure vi.mock has hoisted before resolution.
const { registerTemplateTools } = await import("../tools/templateTools.js");

function callBundleTool(args: Record<string, unknown>) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTemplateTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tool = (server as any)._registeredTools["get_template_preview_bundle"];
  return tool.handler(args, { sessionId: "test-session" });
}

async function callBundle(templateId = "tpl_x") {
  const r = await callBundleTool({ templateId });
  return JSON.parse(r.content[0].text);
}

beforeEach(() => api.reset());

describe("get_template_preview_bundle", () => {

  it("picks the zone with the highest ad count", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({
      data: { id: "tpl_x", html: "<h1>{{ headline }}</h1>", css: ".a{}", creativeAssetGroupId: "cag_y", version: 3 },
    }));
    api.on("GET", /^\/api\/creative-asset-groups\/cag_y$/, () => ({
      data: { fields: [{ name: "headline", type: "string" }] },
    }));
    api.on("GET", /^\/api\/zones$/, () => ({ data: [
      { id: "zn_A", templateId: "tpl_x" },
      { id: "zn_B", templateId: "tpl_x" },
    ]}));
    api.on("GET", /^\/api\/zones\/zn_A\/ads$/, () => ({ data: [{ headline: "A1" }, { headline: "A2" }] }));
    api.on("GET", /^\/api\/zones\/zn_B\/ads$/, () => ({ data: [{ headline: "B1" }, { headline: "B2" }, { headline: "B3" }] }));

    const out = await callBundle();
    expect(out.source).toBe("zone");
    expect(out.chosenZoneId).toBe("zn_B");
    expect(out.mockAds).toHaveLength(3);
    expect(out.mockAds[0].headline).toBe("B1");
    expect(out.warnings).toEqual([]);
  });

  it("ignores zones bound to a different template", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({ data: { id: "tpl_x", html: "", css: "", creativeAssetGroupId: "cag_y" } }));
    api.on("GET", /^\/api\/creative-asset-groups\/cag_y$/, () => ({ data: { fields: [{ name: "headline", type: "string" }] } }));
    api.on("GET", /^\/api\/zones$/, () => ({ data: [
      { id: "zn_A", templateId: "tpl_x" },
      { id: "zn_other", templateId: "tpl_other" },  // must be filtered out
    ]}));
    api.on("GET", /^\/api\/zones\/zn_A\/ads$/, () => ({ data: [{ headline: "A1" }] }));
    // NOTE: no handler for /api/zones/zn_other/ads — if the tool tries to fetch it, the mock throws "unmatched"
    const out = await callBundle();
    expect(out.chosenZoneId).toBe("zn_A");
    expect(out.source).toBe("zone");
  });

  it("breaks ties by API order (first zone wins)", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({ data: { id: "tpl_x", html: "", css: "", creativeAssetGroupId: "cag_y" } }));
    api.on("GET", /^\/api\/creative-asset-groups\/cag_y$/, () => ({ data: { fields: [{ name: "headline", type: "string" }] } }));
    api.on("GET", /^\/api\/zones$/, () => ({ data: [
      { id: "zn_A", templateId: "tpl_x" },
      { id: "zn_B", templateId: "tpl_x" },
    ]}));
    api.on("GET", /^\/api\/zones\/zn_A\/ads$/, () => ({ data: [{ headline: "A1" }] }));
    api.on("GET", /^\/api\/zones\/zn_B\/ads$/, () => ({ data: [{ headline: "B1" }] }));
    const out = await callBundle();
    expect(out.chosenZoneId).toBe("zn_A");
  });

  it("synthesizes when no zone is bound to this template", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({ data: { id: "tpl_x", html: "<h1>{{ headline }}</h1>", css: "", creativeAssetGroupId: "cag_y" } }));
    api.on("GET", /^\/api\/creative-asset-groups\/cag_y$/, () => ({ data: { fields: [{ name: "headline", type: "string" }] } }));
    api.on("GET", /^\/api\/zones$/, () => ({ data: [{ id: "zn_other", templateId: "tpl_other" }] }));
    const out = await callBundle();
    expect(out.source).toBe("synthesized");
    expect(out.chosenZoneId).toBeNull();
    expect(out.mockAds).toHaveLength(2);
    // generateMockAds in templateTools.ts produces "Mock headline 1" for a string field named "headline".
    expect(out.mockAds[0].headline).toBe("Mock headline 1");
    expect(out.warnings.join(" ")).toMatch(/no zones/i);
  });

  it("synthesizes when every bound zone is empty", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({ data: { id: "tpl_x", html: "", css: "", creativeAssetGroupId: "cag_y" } }));
    api.on("GET", /^\/api\/creative-asset-groups\/cag_y$/, () => ({ data: { fields: [{ name: "headline", type: "string" }] } }));
    api.on("GET", /^\/api\/zones$/, () => ({ data: [{ id: "zn_A", templateId: "tpl_x" }] }));
    api.on("GET", /^\/api\/zones\/zn_A\/ads$/, () => ({ data: [] }));
    const out = await callBundle();
    expect(out.source).toBe("synthesized");
    expect(out.warnings.join(" ")).toMatch(/empty/i);
  });

  it("errors when the template has no CAG", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({ data: { id: "tpl_x", html: "", css: "" /* no creativeAssetGroupId */ } }));
    const r = await callBundleTool({ templateId: "tpl_x" });
    expect(r.content[0].text).toMatch(/no linked creative asset group/i);
  });

  it("falls through to synthesized if zones endpoint itself fails", async () => {
    api.on("GET", /^\/api\/templates\/tpl_x$/, () => ({ data: { id: "tpl_x", html: "", css: "", creativeAssetGroupId: "cag_y" } }));
    api.on("GET", /^\/api\/creative-asset-groups\/cag_y$/, () => ({ data: { fields: [{ name: "headline", type: "string" }] } }));
    api.on("GET", /^\/api\/zones$/, () => { throw new Error("zones endpoint 500"); });
    const out = await callBundle();
    expect(out.source).toBe("synthesized");
    expect(out.warnings.join(" ")).toMatch(/zone resolution failed/i);
  });
});
