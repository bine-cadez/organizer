import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Operator-only credentials stay in memory and never enter request logs. */
export async function cloudflareApi() {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["node_modules/wrangler/bin/wrangler.js", "auth", "token", "--json"],
    { maxBuffer: 1024 * 1024 },
  );
  const credentials = JSON.parse(stdout.trim());
  const authentication =
    credentials.type === "api_key"
      ? { "X-Auth-Key": credentials.key, "X-Auth-Email": credentials.email }
      : { Authorization: `Bearer ${credentials.token}` };
  return async (path, options = {}) => {
    if (!path.startsWith("/accounts/") && path !== "/accounts")
      throw new Error("Unsupported operator API path.");
    const response = await fetch(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        ...options,
        headers: {
          ...authentication,
          "Content-Type": "application/json",
          ...options.headers,
        },
        signal: AbortSignal.timeout(60000),
      },
    );
    const data = await response.json();
    if (!response.ok || !data.success)
      throw new Error(
        `Cloudflare API ${options.method || "GET"} ${path} failed: HTTP ${response.status}, codes ${(data.errors || []).map((error) => error.code).join(",")}.`,
      );
    return data.result;
  };
}
