/**
 * tests/helpers/mockWorkApi.ts
 *
 * Reusable vitest mock for workApiRequest and related sessionManager exports.
 *
 * Usage in a test file:
 *
 *   import { mockWorkApi } from "./helpers/mockWorkApi.js";
 *   const api = mockWorkApi();
 *   // Dynamically import the tool module AFTER this import so that vi.mock
 *   // (which is hoisted at parse time) has already replaced the real module.
 *   const { myTool } = await import("../tools/myTool.js");
 *
 *   beforeEach(() => api.reset());
 *
 *   it("...", async () => {
 *     api.on("GET", /\/templates\/123$/, () => ({ id: "123", name: "My Template" }));
 *     await myTool(...);
 *   });
 *
 * IMPORTANT — vi.mock hoisting:
 *   vitest statically hoists vi.mock() calls to the top of the file before any
 *   imports are resolved. The calls below are therefore processed before this
 *   module's own imports execute, which is exactly what we need: any test file
 *   that imports this helper will have these mocks in place when it later imports
 *   the production modules (either statically or via dynamic import).
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level handler registry (mutable by exported setters below)
// ---------------------------------------------------------------------------

                
                 
                 
                                                         
  

const handlers            = [];

// ---------------------------------------------------------------------------
// vi.mock declarations — MUST stay at module top-level so vitest hoists them
// ---------------------------------------------------------------------------

vi.mock("../../services/workApi.js", () => ({
  workApiRequest: vi.fn(async (
    _session         ,
    method        ,
    path        ,
    opts                                       
  ) => {
    const match = handlers.find(
      (h) => h.method === method && h.pathRe.test(path)
    );
    if (!match) {
      throw new Error(`mockWorkApi: unmatched ${method} ${path}`);
    }
    return match.handler(opts?.params);
  }),
  handleWorkApiError: (err       ) => `Error: ${err.message}`,
  truncateIfNeeded: (s        ) => s,
  stripListItems: (d         ) => d,
}));

vi.mock("../../services/sessionManager.js", () => ({
  resolveLincxSession: async () => "test-session",
  validateSession: async () => ({ valid: true, session: { token: "t" } }),
}));

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Register a handler that intercepts workApiRequest calls matching the given
 * HTTP method and path regular expression.
 *
 * Handlers are tested in insertion order; the first match wins.
 */
export function on(
  method        ,
  pathRe        ,
  handler                                               
)       {
  handlers.push({ method, pathRe, handler });
}

/**
 * Remove all registered handlers. Call in beforeEach() to keep tests isolated.
 */
export function reset()       {
  handlers.length = 0;
}

/**
 * Convenience wrapper that returns { on, reset } — mirrors the plan's
 * originally described API.
 */
export function mockWorkApi()                                         {
  return { on, reset };
}
