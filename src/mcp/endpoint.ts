import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { executeTool, type McpContext } from "./dispatch";
import { getPrompt, promptDefinitions } from "./prompts";
import { effectiveScopes, permittedTools } from "./registry";
import { readResource, resourceDefinitions } from "./resources";

const outputSchema = z
  .object({
    data: z.unknown(),
    meta: z
      .object({
        asOf: z.string(),
        timezone: z.string(),
        ownerRevision: z.string(),
        versions: z.record(z.string(), z.string()),
        warnings: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .strict();

/** Auth is supplied by the verified OAuth wrapper, never inferred from request headers here. */
export function createOrganizerMcpServer(context: McpContext): McpServer {
  const server = new McpServer(
    { name: "organizer", version: "0.1.0" },
    { maxToolInputElements: 6000 },
  );
  for (const definition of permittedTools(context.actor.scopes)) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: definition.destructive,
          idempotentHint: !definition.readOnly,
          openWorldHint: definition.openWorld,
        },
        _meta: { "organizer/requiredScopes": [...definition.scopes] },
      },
      async (args) => executeTool(definition.name, args, context),
    );
  }
  const scopes = effectiveScopes(context.actor.scopes);
  if (scopes.has("organizer:read")) {
    for (const resource of resourceDefinitions) {
      if (
        resource.uri.startsWith("organizer://calendar/") &&
        !scopes.has("calendar:busy:read")
      )
        continue;
      const metadata = {
        description: resource.description,
        mimeType: "application/json",
        cacheHint: { ttlMs: 0, cacheScope: "private" as const },
      };
      if (resource.uri.includes("{"))
        server.registerResource(
          resource.name,
          new ResourceTemplate(resource.uri, { list: undefined }),
          metadata,
          async (uri) => readResource(uri.href, context),
        );
      else
        server.registerResource(
          resource.name,
          resource.uri,
          metadata,
          async (uri) => readResource(uri.href, context),
        );
    }
    for (const prompt of promptDefinitions) {
      server.registerPrompt(
        prompt.name,
        {
          description: prompt.description,
          argsSchema: z.object(prompt.argsSchema).strict(),
        },
        async (args) => getPrompt(prompt.name, args, context),
      );
    }
  }
  return server;
}

export function createMcpEndpoint(
  contextForRequest: (request: Request) => Promise<McpContext>,
) {
  return {
    async fetch(
      request: Request,
      env?: unknown,
      executionContext?: ExecutionContext,
    ): Promise<Response> {
      const context = await contextForRequest(request);
      const configuredOrigin = new URL(context.origin);
      if (new URL(request.url).hostname !== configuredOrigin.hostname)
        return new Response("Invalid host.", { status: 403 });
      const origin = request.headers.get("Origin");
      if (origin && origin !== configuredOrigin.origin)
        return new Response("Invalid origin.", { status: 403 });
      const handler = createMcpHandler(
        () => createOrganizerMcpServer(context),
        {
          route: "/mcp",
          legacy: "stateless",
          allowedHostnames: [configuredOrigin.hostname],
          allowedOriginHostnames: [configuredOrigin.hostname],
          corsOptions: { origin: configuredOrigin.origin },
        },
      );
      // Preserve OAuthProvider's verified request context when supplied by the Worker.
      return executionContext
        ? handler(request, env, executionContext)
        : handler.fetch(request);
    },
  };
}
