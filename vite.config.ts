import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: Object.fromEntries(
      [
        "/api",
        "/auth",
        "/mcp",
        "/authorize",
        "/token",
        "/register",
        "/revoke",
        "/.well-known",
      ].map((path) => [path, { target: "http://127.0.0.1:8787" }]),
    ),
  },
});
