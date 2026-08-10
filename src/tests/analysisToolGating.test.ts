import { describe, it, expect } from "vitest";

// constants.ts reads NODE_ENV at load, so set it BEFORE importing the tools.
process.env.NODE_ENV = "production";

const { registerAnalysisTools } = await import("../tools/analysisTools.js");

/** Minimal McpServer stand-in — we only care about which names get registered. */
function collectRegisteredNames(): string[] {
  const names: string[] = [];
  const fake = { registerTool: (name: string) => { names.push(name); } };
  registerAnalysisTools(fake as never);
  return names;
}

describe("analysis tool registration under NODE_ENV=production", () => {
  it("hides create_analysis but keeps the read tools", () => {
    const names = collectRegisteredNames();
    expect(names).not.toContain("create_analysis");
    expect(names).toContain("get_analysis");
    expect(names).toContain("list_analyses");
  });
});
