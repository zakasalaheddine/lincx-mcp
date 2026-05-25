import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mockWorkApi } from "./helpers/mockWorkApi.js";

const api = mockWorkApi();

// Import AFTER the helper so vi.mock has hoisted before module resolution.
const { registerReportingTools } = await import("../tools/reportingTools.js");

function getReportTool() {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerReportingTools(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server as any)._registeredTools["report_query"];
}

const ROWS = [
  { zone: "A", date: "2026-05-19", hour: "00", loads: 100, revenue: 1.5, level: "x" },
  { zone: "A", date: "2026-05-19", hour: "01", loads: 50, revenue: 0.5, level: "x" },
  { zone: "B", date: "2026-05-19", hour: "00", loads: 20, revenue: 0.1, level: "x" },
];

beforeEach(() => api.reset());

describe("report_query structured output (T2-2)", () => {
  it("aggregated mode: structuredContent matches the declared outputSchema and mirrors content text", async () => {
    api.on("GET", /^\/api\/reports\/ds1$/, () => ROWS);
    const tool = getReportTool();

    const r = await tool.handler(
      { dimensionSetId: "ds1", startDate: "2026-05-19", endDate: "2026-05-19", groupBy: ["zone"], raw: false },
      { sessionId: "test-session" },
    );

    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent.total.loads).toBe(170);
    expect(r.structuredContent.groups).toHaveLength(2);
    // content text is functionally equivalent (spec back-compat requirement).
    expect(JSON.parse(r.content[0].text).total.loads).toBe(170);
    // The SDK validates structuredContent against tool.outputSchema before sending —
    // assert that contract holds here.
    expect(tool.outputSchema.safeParse(r.structuredContent).success).toBe(true);
  });

  it("raw mode: structuredContent carries raw rows and still validates against outputSchema", async () => {
    api.on("GET", /^\/api\/reports\/ds1$/, () => ROWS);
    const tool = getReportTool();

    const r = await tool.handler(
      { dimensionSetId: "ds1", startDate: "2026-05-19", endDate: "2026-05-19", raw: true },
      { sessionId: "test-session" },
    );

    expect(r.structuredContent.raw).toHaveLength(3);
    expect(r.structuredContent.total).toBeUndefined();
    expect(tool.outputSchema.safeParse(r.structuredContent).success).toBe(true);
  });
});
