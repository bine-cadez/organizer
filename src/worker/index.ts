import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import OAuthProvider, {
  AuthorizationError,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { ALL_SCOPES, type Actor, type CalendarRole } from "../shared/types";
import { BookCatalog } from "../integrations/books";
import { createMcpEndpoint, executeTool, type McpContext } from "../mcp";
import { OrganizerStore } from "../storage/organizer";
import {
  actorFor,
  authPage,
  beginGoogle,
  escapeHtml,
  finishGoogle,
  getSession,
  googleConfigured,
  localDevelopment,
  logout,
  oauthCallbackPage,
  requireBrowserWrite,
  type Session,
} from "./auth";
import { touchOrganizerAlarm } from "./alarm";
import type { AppEnv } from "./env";

export { OrganizerStore };
type AppBindings = { Bindings: AppEnv; Variables: { session: Session | null } };
const app = new Hono<AppBindings>();
const OAUTH_SCOPES = [...ALL_SCOPES, "offline_access"];
app.use("*", bodyLimit({ maxSize: 128 * 1024 }));
app.use("*", async (c, next) => {
  c.set("session", await getSession(c.req.raw, c.env));
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header(
    "Referrer-Policy",
    c.res.headers.get("Referrer-Policy") || "same-origin",
  );
  if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/auth/"))
    c.header("Cache-Control", "no-store");
});
app.onError((error, c) => {
  if (error instanceof AuthorizationError)
    return authPage(
      "Agent connection could not finish",
      `<p>${escapeHtml(error.description)}</p><a href="/#/settings">Back to settings</a>`,
    );
  const safe = error as Error & {
    code?: string;
    status?: number;
    details?: unknown;
  };
  const status =
    safe.status && safe.status >= 400 && safe.status < 600 ? safe.status : 500;
  if (status >= 500)
    console.error(
      JSON.stringify({
        event: "request_failed",
        code: safe.code || "INTERNAL_ERROR",
        path: c.req.path,
      }),
    );
  return Response.json(
    {
      error: {
        code: safe.code || "INTERNAL_ERROR",
        message:
          status >= 500 && !safe.code
            ? "Organizer could not complete this request. Try again."
            : safe.message,
        ...(safe.details ? { details: safe.details } : {}),
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
});
app.get("/api/session", (c) =>
  c.json({
    authenticated: Boolean(c.get("session")),
    localDevelopment: localDevelopment(c.req.raw, c.env),
    configured: googleConfigured(c.env),
    email: c.get("session")?.email,
  }),
);
app.use("/api/*", async (c, next) => {
  if (!c.get("session"))
    return c.json(
      { error: { code: "SESSION_REQUIRED", message: "Sign in to Organizer." } },
      401,
    );
  await next();
});

async function contextFor(
  request: Request,
  env: AppEnv,
  actor: Actor,
  ownerSub: string,
): Promise<McpContext> {
  const store = env.ORGANIZER.getByName(ownerSub);
  // Tool listing and token traffic never call the object. This does, at most
  // once a minute, so a dropped alarm is armed again on ordinary /mcp use.
  await touchOrganizerAlarm(ownerSub, () => store.ensureAlarm());
  const contact = env.CONTACT_EMAIL || env.OWNER_EMAIL;
  const catalog = new BookCatalog(env.OAUTH_KV, contact, fetch, async () => {
    const delay = await store.catalogPermit(Boolean(contact));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  });
  return {
    actor,
    origin: localDevelopment(request, env)
      ? new URL(request.url).origin
      : env.APP_ORIGIN || new URL(request.url).origin,
    snapshot: () => store.snapshot(),
    execute: async (name, args) => {
      const result: unknown = await store.execute(name, args, actor);
      if (result && typeof result === "object" && "error" in result) {
        const error = result.error as {
          message: string;
          code: string;
          status: number;
          details?: unknown;
          retryable?: boolean;
        };
        throw Object.assign(new Error(error.message), error);
      }
      return result;
    },
    searchBooks: (query, limit, cursor) => catalog.search(query, limit, cursor),
    getBookCandidate: (input) => catalog.candidate(input),
    connectUrl: (role) => `/auth/calendar?role=${role}`,
  };
}
app.get("/api/state", async (c) =>
  c.json(await c.env.ORGANIZER.getByName(c.get("session")!.sub).snapshot()),
);
app.get("/api/books/search", async (c) => {
  const context = await contextFor(
    c.req.raw,
    c.env,
    actorFor(c.get("session")!),
    c.get("session")!.sub,
  );
  return c.json(
    await context.searchBooks(
      c.req.query("q") || "",
      10,
      c.req.query("cursor"),
    ),
  );
});
app.post("/api/commands/:name", async (c) => {
  requireBrowserWrite(c.req.raw);
  const args = await c.req.json<Record<string, unknown>>();
  if (c.req.param("name") === "skip_setup")
    return c.json({
      data: await c.env.ORGANIZER.getByName(c.get("session")!.sub).skipSetup(),
    });
  const context = await contextFor(
    c.req.raw,
    c.env,
    actorFor(c.get("session")!),
    c.get("session")!.sub,
  );
  const result = await executeTool(c.req.param("name"), args, context);
  return Response.json(result.structuredContent, {
    status: result.isError ? 400 : 200,
    headers: { "Cache-Control": "no-store" },
  });
});
app.get("/api/clients", async (c) => {
  if (!c.env.OAUTH_PROVIDER) return c.json({ clients: [] });
  const grants = await c.env.OAUTH_PROVIDER.listUserGrants(
    c.get("session")!.sub,
    { limit: 100 },
  );
  return c.json({
    clients: await Promise.all(
      grants.items.map(async (grant) => {
        const client = await c.env.OAUTH_PROVIDER!.lookupClient(grant.clientId);
        return {
          id: grant.id,
          name: client?.clientName || grant.clientId,
          scopes: grant.scope,
          createdAt: new Date(grant.createdAt * 1000).toISOString(),
        };
      }),
    ),
  });
});
app.post("/api/clients/:id/revoke", async (c) => {
  requireBrowserWrite(c.req.raw);
  if (!c.env.OAUTH_PROVIDER)
    return c.json(
      {
        error: {
          code: "CONFIGURATION_REQUIRED",
          message:
            "Remote OAuth is available on the configured HTTPS deployment.",
        },
      },
      400,
    );
  await c.env.OAUTH_PROVIDER.revokeGrant(
    c.req.param("id"),
    c.get("session")!.sub,
  );
  return c.json({ revoked: true });
});
app.get("/auth/login", (c) =>
  beginGoogle(c.req.raw, c.env, c.get("session"), "login"),
);
app.get("/auth/calendar", async (c) => {
  const role = c.req.query("role");
  if (role !== "personal" && role !== "work")
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Choose Personal or Work.",
        },
      },
      400,
    );
  return beginGoogle(c.req.raw, c.env, c.get("session"), "calendar", role);
});
app.get("/auth/callback", (c) =>
  finishGoogle(c.req.raw, c.env, c.get("session")),
);
app.post("/auth/logout", (c) => logout(c.req.raw, c.env));
app.get("/authorize", async (c) => {
  const oauth = c.env.OAUTH_PROVIDER;
  if (!oauth)
    return authPage(
      "Connect an agent",
      '<p>The local MCP endpoint is available on this computer. Remote OAuth connections become available after the HTTPS deployment is configured.</p><a href="/#/settings">Back to settings</a>',
    );
  const session = c.get("session");
  if (!session)
    return c.redirect(
      `/auth/login?returnTo=${encodeURIComponent(c.req.path + new URL(c.req.url).search)}`,
    );
  const authorization = await oauth.parseAuthRequest(c.req.raw);
  const details = await oauth.describeConsent(authorization);
  const consent = await oauth.beginConsent(authorization);
  const scopes = OAUTH_SCOPES.map((scope) =>
    scope === "organizer:read"
      ? '<input type="hidden" name="scope" value="organizer:read"><label><input type="checkbox" checked disabled> organizer:read (required)</label>'
      : `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${details.scope.includes(scope) ? " checked" : ""}> ${escapeHtml(scope)}</label>`,
  ).join("");
  return authPage(
    "Allow this agent to use Organizer?",
    `<p><strong>${escapeHtml(details.clientName)}</strong> is asking for access.</p><p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${details.clientDomain ? `<p>Published by ${escapeHtml(details.clientDomain)}.</p>` : "<p>This client name is self-registered.</p>"}${details.redirectIsLoopback ? "<p>This connects an app on your computer. Continue only if you started this connection.</p>" : ""}<form method="post" action="/authorize"><input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">${scopes}<p>Allowed actions can run without asking again. Place limits and Work read-only rules always apply.</p><button name="decision" value="approve">Allow access</button> <button class="secondary" name="decision" value="deny">Deny</button></form>`,
    consent.headers,
  );
});
app.post("/authorize", async (c) => {
  const session = c.get("session"),
    oauth = c.env.OAUTH_PROVIDER;
  if (!session || !oauth)
    return c.json(
      {
        error: {
          code: "SESSION_REQUIRED",
          message: "Sign in and restart the agent connection.",
        },
      },
      401,
    );
  const form = await c.req.formData(),
    handle = String(form.get("handle") || "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(c.req.raw, handle);
    return oauthCallbackPage(denied.redirectTo, denied.headers);
  }
  const approved = await oauth.approveConsent(c.req.raw, handle, {
    scope: form
      .getAll("scope")
      .map(String)
      .filter((scope) => OAUTH_SCOPES.includes(scope)),
  });
  const result = await oauth.completeAuthorization({
    request: approved.request,
    userId: session.sub,
    metadata: { label: "Organizer agent" },
    scope: approved.request.scope,
    props: {
      ownerSub: session.sub,
      email: session.email,
      actorId: crypto.randomUUID(),
    },
  });
  return oauthCallbackPage(result.redirectTo, approved.headers);
});
app.get("/api/health", (c) => c.json({ ok: true }));
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      if (localDevelopment(request, env)) {
        if (new URL(request.url).pathname === "/mcp")
          return createMcpEndpoint(async (req) =>
            contextFor(
              req,
              env,
              { id: "local-agent", type: "agent", scopes: [...ALL_SCOPES] },
              "local-owner",
            ),
          ).fetch(request, env, ctx);
        return app.fetch(request, env, ctx);
      }
      const origin = env.APP_ORIGIN || new URL(request.url).origin;
      const provider = new OAuthProvider<AppEnv>({
        apiRoute: "/mcp",
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register",
        scopesSupported: OAUTH_SCOPES,
        requiredScopes: ["organizer:read"],
        clientIdMetadataDocumentEnabled: true,
        resourceMetadata: {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          resource_name: "Organizer",
        },
        accessTokenTTL: 3600,
        refreshTokenTTL: 60 * 60 * 24 * 30,
        apiHandler: {
          async fetch(req, bindings, execution) {
            const verified = execution as OAuthResourceContext<{
              ownerSub: string;
              email: string;
              actorId: string;
            }>;
            const pinned =
              bindings.OWNER_GOOGLE_SUB ||
              (await bindings.OAUTH_KV.get("owner:google-sub"));
            if (
              !pinned ||
              verified.props.ownerSub !== pinned ||
              verified.auth.userId !== pinned ||
              !verified.auth.scope.includes("organizer:read")
            )
              return Response.json(
                { error: "Access denied." },
                { status: 403 },
              );
            const actor: Actor = {
              id: `${verified.auth.clientId || "oauth-client"}:${verified.props.actorId}`,
              type: "agent",
              scopes: verified.auth.scope,
            };
            return createMcpEndpoint(async (incoming) =>
              contextFor(incoming, bindings, actor, pinned),
            ).fetch(req, bindings, verified);
          },
        },
        defaultHandler: {
          fetch: (req, bindings, execution) =>
            app.fetch(req, bindings, execution),
        },
      });
      return await provider.fetch(request, env, ctx);
    } catch (error) {
      if (error instanceof AuthorizationError) {
        if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
        return authPage(
          "Agent connection could not finish",
          `<p>${escapeHtml(error.description)}</p><a href="/#/settings">Back to settings</a>`,
        );
      }
      console.error(
        JSON.stringify({
          event: "worker_failed",
          path: new URL(request.url).pathname,
        }),
      );
      return Response.json(
        {
          error: {
            code: "INTERNAL_ERROR",
            message:
              "Organizer could not complete this request. Check the connection configuration and try again.",
          },
        },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AppEnv>;
