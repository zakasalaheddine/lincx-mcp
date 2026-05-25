import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mockWorkApi } from "./helpers/mockWorkApi.js";

const api = mockWorkApi();

// Import AFTER the helper so vi.mock has hoisted.
const { registerResources } = await import("../tools/resources.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function build(): any {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerResources(server);
  return server;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extra = { sessionId: "test-session" } as any;

beforeEach(() => api.reset());

describe("resources (T1-3 / T4-6)", () => {
  it("registers lincx://networks as a static (listable) resource", async () => {
    const server = build();
    const res = server._registeredResources["lincx://networks"];
    expect(res).toBeDefined();

    const out = await res.readCallback(new URL("lincx://networks"), extra);
    expect(out.contents[0].mimeType).toBe("application/json");
    const body = JSON.parse(out.contents[0].text);
    expect(Array.isArray(body.networks)).toBe(true);
    // (active_network is present on a real Session; the test stub omits it, so
    // JSON.stringify drops the undefined key — not asserted here.)
  });

  it("registers entity resource templates that fetch by id", async () => {
    api.on("GET", /^\/api\/campaigns\/c1$/, () => ({ id: "c1", name: "Camp" }));
    const server = build();
    const tmpl = server._registeredResourceTemplates["campaign-by-id"];
    expect(tmpl).toBeDefined();

    const out = await tmpl.readCallback(new URL("lincx://campaign/c1"), { id: "c1" }, extra);
    expect(JSON.parse(out.contents[0].text)).toEqual({ id: "c1", name: "Camp" });
  });

  it("entity templates carry no list callback — zero per-request (resources/list) cost", () => {
    const server = build();
    // Static resource is listed; templates without a list callback are not.
    expect(Object.keys(server._registeredResources)).toContain("lincx://networks");
    expect(server._registeredResourceTemplates["zone-by-id"].resourceTemplate.listCallback).toBeUndefined();
  });

  it("a resource read surfaces a clean error (not a throw) on upstream failure", async () => {
    // No handler registered for ads/zX → mockWorkApi throws → handleWorkApiError formats it.
    const server = build();
    const tmpl = server._registeredResourceTemplates["zone-by-id"];
    const out = await tmpl.readCallback(new URL("lincx://zone/zX"), { id: "zX" }, extra);
    expect(out.contents[0].mimeType).toBe("text/plain");
    expect(out.contents[0].text).toMatch(/^Error:/);
  });

  it("records a usage event when a resource is read", async () => {
    const { getEventSink } = await import("../services/usageAnalytics.js");
    api.on("GET", /^\/api\/campaigns\/c9$/, () => ({ id: "c9", name: "C" }));
    const server = build();
    const tmpl = server._registeredResourceTemplates["campaign-by-id"];

    await tmpl.readCallback(new URL("lincx://campaign/c9"), { id: "c9" }, extra);
    await new Promise((r) => setTimeout(r, 20));

    const recent = await (await getEventSink()).readRecent(5);
    const rec = recent.find((e) => e.type === "resource" && e.name === "campaign-by-id");
    expect(rec?.status).toBe("ok");
  });

  it("e2e: a real client sees lincx://networks in resources/list and can read it", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerResources(server);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    try {
      const list = await client.listResources();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(list.resources.map((r: any) => r.uri)).toContain("lincx://networks");

      const tmpls = await client.listResourceTemplates();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(tmpls.resourceTemplates.map((t: any) => t.uriTemplate)).toContain("lincx://campaign/{id}");

      const read = await client.readResource({ uri: "lincx://networks" });
      expect(Array.isArray(JSON.parse(read.contents[0].text as string).networks)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
