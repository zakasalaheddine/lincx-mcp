import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    environment: "node",
    // Pinned so assertions never depend on the developer's .env — constants.ts
    // reads both at module scope. redisIntegration opts back in via TEST_REDIS_URL.
    env: { STATS_TOKEN: "", REDIS_URL: "" },
    pool: "forks",
  },
});
