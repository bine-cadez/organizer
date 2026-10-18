import assert from "node:assert/strict";

const origin = new URL(process.argv[2]).origin;
assert.equal(
  new URL(origin).protocol,
  "https:",
  "Check the production HTTPS origin.",
);
const paths = [
  "/",
  "/api/session",
  "/api/state",
  "/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource/mcp",
];
const responses = await Promise.all(
  paths.map((path) =>
    fetch(`${origin}${path}`, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    }),
  ),
);
const [page, session, state, mcp, authorization, resource] = responses;
assert.equal(page.status, 200, "App shell is unavailable.");
assert.match(await page.text(), /id="root"/, "App shell is missing.");
assert.equal(session.status, 200);
const identity = await session.json();
assert.equal(
  identity.authenticated,
  false,
  "Anonymous request was authenticated.",
);
assert.equal(
  identity.localDevelopment,
  false,
  "Production must not bypass owner login.",
);
assert.equal(state.status, 401, "Anonymous database access must be rejected.");
assert.equal(mcp.status, 401, "Anonymous agent access must be rejected.");
assert.ok(
  mcp.headers
    .get("www-authenticate")
    ?.includes(`${origin}/.well-known/oauth-protected-resource/mcp`),
);
assert.equal(authorization.status, 200);
const server = await authorization.json();
assert.equal(server.issuer, origin);
assert.ok(server.code_challenge_methods_supported.includes("S256"));
assert.equal(resource.status, 200);
assert.equal((await resource.json()).resource, `${origin}/mcp`);
console.log(
  `Verified production app, authentication boundary and MCP discovery at ${origin}`,
);
