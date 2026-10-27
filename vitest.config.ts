import path from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": path.resolve("tests/stubs/cloudflare-workers.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    environment: "node",
    server: {
      deps: {
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
