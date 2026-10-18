import { describe, expect, it, vi } from "vitest";
import { ALL_SCOPES, type Snapshot } from "../src/shared/types";
import { executeTool, type McpContext } from "../src/mcp/dispatch";
import { permittedTools, toolDefinitions } from "../src/mcp/registry";
import { readResource } from "../src/mcp/resources";
import { getPrompt } from "../src/mcp/prompts";
import { createMcpEndpoint } from "../src/mcp/endpoint";

const snapshot: Snapshot = {
  areas: [],
  items: [],
  tickets: [],
  learnings: [],
  bookings: [],
  connections: [],
  events: [],
  operations: [],
  reviews: [],
  versions: { owner: "1" },
  ownerRevision: "1",
  timezone: "Europe/Ljubljana",
  localDate: "2026-10-18",
  reviewDate: "2026-10-18",
  setupSkipped: false,
};
const meta = {
  asOf: "2026-10-18T18:00:00Z",
  timezone: snapshot.timezone,
  ownerRevision: "1",
  versions: {},
  warnings: [],
};
function context(
  scopes = ALL_SCOPES,
  data: unknown = { summary: "Saved." },
): McpContext {
  return {
    actor: { id: "agent:test", type: "agent", scopes },
    execute: vi.fn(async () => ({ data, meta })),
    snapshot: vi.fn(async () => snapshot),
    searchBooks: vi.fn(async () => ({ items: [], nextCursor: null })),
    getBookCandidate: vi.fn(async () => ({
      editionId: "/books/OL123M",
      workId: "/works/OL456W",
      title: "The Mom Test",
      authors: ["Rob Fitzpatrick"],
      pageCount: 136,
      coverUrl: "https://covers.openlibrary.org/b/id/123-M.jpg?default=false",
    })),
    connectUrl: (role) => `/auth/calendar/${role}`,
    origin: "https://organizer.example",
  };
}
const envelope = {
  idempotencyKey: "test-1",
  expectedVersions: { "item:prj_1": "1" },
};
const errorCode = (result: Awaited<ReturnType<typeof executeTool>>) =>
  (result.structuredContent.error as { code: string }).code;

describe("MCP contract boundary", () => {
  it("publishes all 47 unique tools and hides mutations without standing scopes", () => {
    expect(toolDefinitions).toHaveLength(47);
    expect(
      new Set(toolDefinitions.map((definition) => definition.name)).size,
    ).toBe(47);
    const names = permittedTools(["organizer:read"]).map(
      (definition) => definition.name,
    );
    expect(names).toContain("get_item");
    expect(names).not.toContain("add_learning");
    expect(names).not.toContain("save_review");
    expect(names).not.toContain("list_calendar_events");
  });

  it("denies a lifecycle apply before invoking domain or external adapters", async () => {
    const ctx = context(["organizer:read", "organizer:write"]);
    const result = await executeTool(
      "finish_item",
      { itemId: "prj_1", ...envelope },
      ctx,
    );
    expect(errorCode(result)).toBe("MISSING_SCOPE");
    expect(ctx.execute).not.toHaveBeenCalled();
    expect(ctx.getBookCandidate).not.toHaveBeenCalled();
  });

  it("rejects force flags, agent-supplied enrichment and missing apply idempotency", async () => {
    const ctx = context();
    expect(
      errorCode(
        await executeTool(
          "start_item",
          { itemId: "prj_1", ...envelope, force: true },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "queue_book",
          {
            areaId: "tech",
            source: { type: "open_library", editionId: "/books/OL123M" },
            ...envelope,
            _resolvedBook: { title: "Forged" },
          },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "save_review",
          { date: "2026-10-18", expectedVersions: {} },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("permits an authorized preview without imposing an apply confirmation gate", async () => {
    const ctx = context(["organizer:read", "lifecycle:write"]);
    const result = await executeTool(
      "pause_item",
      { itemId: "prj_1", mode: "preview" },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(ctx.execute).toHaveBeenCalledWith("pause_item", {
      itemId: "prj_1",
      mode: "preview",
    });
  });

  it("enriches book import from a server lookup and never trusts a client cover URL", async () => {
    const ctx = context();
    vi.mocked(ctx.execute).mockRejectedValueOnce(
      Object.assign(new Error("Resolve selected edition before adding it."), {
        code: "BOOK_METADATA_INCOMPLETE",
      }),
    );
    const args = {
      areaId: "tech",
      source: { type: "open_library", editionId: "/books/OL123M" },
      ...envelope,
    };
    const result = await executeTool("queue_book", args, ctx);
    expect(result.isError).toBeUndefined();
    expect(ctx.getBookCandidate).toHaveBeenCalledWith({
      editionId: "/books/OL123M",
    });
    expect(ctx.execute).toHaveBeenCalledWith(
      "queue_book",
      expect.objectContaining({
        _resolvedBook: expect.objectContaining({
          title: "The Mom Test",
          pageCount: 136,
        }),
      }),
    );
    expect(
      errorCode(
        await executeTool(
          "queue_book",
          {
            ...args,
            source: {
              ...args.source,
              coverUrl: "https://attacker.example/image",
            },
          },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
  });

  it("replays a committed book import without relying on Open Library availability", async () => {
    const ctx = context(ALL_SCOPES, { outcome: "applied", deduplicated: true });
    vi.mocked(ctx.getBookCandidate).mockRejectedValue(
      new Error("Provider unavailable."),
    );
    const result = await executeTool(
      "queue_book",
      {
        areaId: "tech",
        source: { type: "open_library", editionId: "/books/OL123M" },
        ...envelope,
      },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data).toEqual({
      outcome: "applied",
      deduplicated: true,
    });
    expect(ctx.execute).toHaveBeenCalledTimes(1);
    expect(ctx.getBookCandidate).not.toHaveBeenCalled();
  });

  it("requires one scoped parent for direct learning and denies backdating/update inventions", async () => {
    const ctx = context();
    expect(
      errorCode(
        await executeTool(
          "add_learning",
          {
            text: "Learning",
            target: { kind: "project", id: "prj_1", bookId: "book_1" },
            ...envelope,
          },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "add_learning",
          {
            text: "Learning",
            target: { kind: "project", id: "prj_1" },
            createdOn: "2026-01-01",
            ...envelope,
          },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "add_learning",
          {
            text: "x".repeat(2001),
            target: { kind: "project", id: "prj_1" },
            ...envelope,
          },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "update_learning",
          { learningId: "l_1", text: "Changed" },
          ctx,
        ),
      ),
    ).toBe("NOT_FOUND");
    const valid = await executeTool(
      "add_learning",
      {
        text: "A user-provided learning.",
        target: { kind: "project", id: "prj_1" },
        ...envelope,
      },
      ctx,
    );
    expect(valid.isError).toBeUndefined();
  });

  it("keeps review book choices staged through the shared draft command", async () => {
    const ctx = context(["organizer:read", "review:write"]);
    const patch = {
      slippedDestinations: [
        {
          ticketId: "tkt_1",
          destination: {
            kind: "book",
            start: "2026-10-19T08:00:00+02:00",
            end: "2026-10-19T09:00:00+02:00",
            allowOverlap: false,
          },
        },
      ],
    };
    await executeTool(
      "update_review_draft",
      { date: "2026-10-18", patch, ...envelope },
      ctx,
    );
    expect(ctx.execute).toHaveBeenCalledExactlyOnceWith("update_review_draft", {
      date: "2026-10-18",
      patch,
      ...envelope,
    });
    expect(ctx.getBookCandidate).not.toHaveBeenCalled();
    expect(
      errorCode(await executeTool("edit_review", { date: "2026-10-18" }, ctx)),
    ).toBe("NOT_FOUND");
  });

  it("does not leak Work titles, descriptions or credentials through either result representation", async () => {
    const ctx = context(["organizer:read", "calendar:busy:read"], {
      items: [
        {
          id: "event_1",
          role: "work",
          title: "Confidential acquisition",
          description: "Secret strategy",
          start: "2026-10-19T08:00:00Z",
          end: "2026-10-19T09:00:00Z",
          allDay: false,
          isBusy: true,
        },
      ],
      refreshToken: "provider-secret",
      connections: [{ encryptedCredentials: "encrypted-secret" }],
    });
    const result = await executeTool(
      "list_calendar_events",
      { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" },
      ctx,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("Busy");
    for (const secret of [
      "Confidential acquisition",
      "Secret strategy",
      "provider-secret",
      "encrypted-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(
      errorCode(
        await executeTool(
          "list_calendar_events",
          {
            start: "2026-10-19T00:00:00Z",
            end: "2026-10-20T00:00:00Z",
            detail: "titles",
          },
          ctx,
        ),
      ),
    ).toBe("MISSING_SCOPE");
  });

  it("removes all external events without busy permission, including nested Today projections", async () => {
    const ctx = context(["organizer:read"], {
      tickets: [{ title: "Own ticket" }],
      events: [
        {
          title: "External secret",
          start: "2026-10-19T08:00:00Z",
          end: "2026-10-19T09:00:00Z",
          role: "work",
        },
      ],
    });
    const result = await executeTool("get_today", {}, ctx);
    expect(JSON.stringify(result)).not.toContain("External secret");
    expect(JSON.stringify(result)).toContain("Own ticket");
    expect(
      (result.structuredContent.data as { events: unknown[] }).events,
    ).toEqual([]);
  });

  it("preserves authorized titles only when details were explicitly requested", async () => {
    const ctx = context(["organizer:read", "calendar:details:read"], {
      items: [
        {
          role: "work",
          title: "Allowed meeting",
          start: "2026-10-19T08:00:00Z",
          end: "2026-10-19T09:00:00Z",
        },
      ],
    });
    const result = await executeTool(
      "list_calendar_events",
      {
        start: "2026-10-19T00:00:00Z",
        end: "2026-10-20T00:00:00Z",
        detail: "titles",
      },
      ctx,
    );
    expect(JSON.stringify(result)).toContain("Allowed meeting");
  });

  it("filters learning retrieval to the requested parent and removes accidental global lists", async () => {
    const data = {
      item: { id: "prj_1", kind: "project" },
      learnings: {
        items: [
          { id: "l_1", projectId: "prj_1", text: "Requested parent" },
          { id: "l_2", bookId: "book_2", text: "Other parent" },
        ],
        nextCursor: null,
      },
    };
    const ctx = context(["organizer:read"], data);
    const parent = await executeTool("get_item", { itemId: "prj_1" }, ctx);
    expect(JSON.stringify(parent)).toContain("Requested parent");
    expect(JSON.stringify(parent)).not.toContain("Other parent");
    const board = await executeTool("get_board", {}, ctx);
    expect(JSON.stringify(board)).not.toContain("Requested parent");
  });

  it("checks query combinations, real dates and range bounds before executing", async () => {
    const ctx = context();
    expect(
      errorCode(await executeTool("get_today", { date: "2026-02-31" }, ctx)),
    ).toBe("VALIDATION_ERROR");
    expect(errorCode(await executeTool("list_tickets", {}, ctx))).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      errorCode(
        await executeTool(
          "get_book_candidate",
          { editionId: "/books/OL123M", isbn: "9781491903063" },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "list_bookings",
          {
            ticketId: "tkt_1",
            start: "2026-10-19T00:00:00Z",
            end: "2026-10-20T00:00:00Z",
          },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      errorCode(
        await executeTool(
          "list_calendar_events",
          { start: "2026-01-01T00:00:00Z", end: "2026-10-20T00:00:00Z" },
          ctx,
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(ctx.execute).not.toHaveBeenCalled();
  });

  it("resources use the same dispatcher, calendar redaction and parent-kind guard", async () => {
    const ctx = context(["organizer:read", "calendar:busy:read"], {
      items: [
        {
          role: "work",
          title: "Secret meeting",
          start: "2026-10-19T08:00:00Z",
          end: "2026-10-19T09:00:00Z",
        },
      ],
    });
    const resource = await readResource(
      "organizer://calendar/2026-10-19/2026-10-20",
      ctx,
    );
    expect(JSON.stringify(resource)).not.toContain("Secret meeting");
    expect(ctx.execute).toHaveBeenCalledWith(
      "list_calendar_events",
      expect.objectContaining({
        detail: "busy",
        start: "2026-10-18T22:00:00.000Z",
      }),
    );
    await expect(
      readResource(
        "organizer://calendar/2026-10-19/2026-10-20",
        context(["organizer:read"]),
      ),
    ).rejects.toThrow("MISSING_SCOPE");
    await expect(
      readResource(
        "organizer://projects/book_1",
        context(["organizer:read"], { item: { kind: "book" } }),
      ),
    ).rejects.toThrow("not found");
    await expect(readResource("file:///etc/passwd", ctx)).rejects.toThrow(
      "Unknown",
    );
  });

  it("prompts preserve immutable-review and staged-booking rules and reject unknown arguments", () => {
    const prompt = getPrompt("evening_review", {}, context(["organizer:read"]));
    expect(prompt.messages[0].content.text).toContain("saved review as final");
    expect(prompt.messages[0].content.text).toContain("never call book_ticket");
    expect(() =>
      getPrompt("evening_review", { reopen: true }, context()),
    ).toThrow();
  });

  it("standard HTTP endpoint validates browser origins before handling protocol requests", async () => {
    const endpoint = createMcpEndpoint(async () => context());
    const response = await endpoint.fetch(
      new Request("https://organizer.example/mcp", {
        method: "POST",
        headers: {
          Origin: "https://attacker.example",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("serves SDK discovery, all tool schemas and a tool call over standard stateless HTTP", async () => {
    const ctx = context();
    const endpoint = createMcpEndpoint(async () => ctx);
    const call = async (
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      const response = await endpoint.fetch(
        new Request("https://organizer.example/mcp", {
          method: "POST",
          headers: {
            Host: "organizer.example",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      const document = response.headers
        .get("Content-Type")
        ?.includes("text/event-stream")
        ? body
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => JSON.parse(line.slice(5)))
            .find((message) => message.id === 1)
        : JSON.parse(body);
      return document as {
        result: {
          tools?: {
            name: string;
            inputSchema: { additionalProperties?: boolean };
          }[];
          structuredContent?: { data: unknown };
        };
        error?: unknown;
      };
    };
    const initialized = await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "organizer-test", version: "1" },
    });
    expect(initialized.error).toBeUndefined();
    const listed = await call("tools/list");
    expect(listed.error).toBeUndefined();
    expect(listed.result.tools).toHaveLength(47);
    expect(
      listed.result.tools?.find((tool) => tool.name === "queue_book")
        ?.inputSchema.additionalProperties,
    ).toBe(false);
    const result = await call("tools/call", {
      name: "add_learning",
      arguments: {
        text: "Captured by an agent.",
        target: { kind: "project", id: "prj_1" },
        ...envelope,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.result.structuredContent?.data).toEqual({
      summary: "Saved.",
    });
    expect(ctx.execute).toHaveBeenCalledWith(
      "add_learning",
      expect.objectContaining({ text: "Captured by an agent." }),
    );
  });

  it("serves modern per-request MCP with grant-filtered discovery and registered prompts/resources", async () => {
    const endpoint = createMcpEndpoint(async () => context(["organizer:read"]));
    const call = async (
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      const response = await endpoint.fetch(
        new Request("https://organizer.example/mcp", {
          method: "POST",
          headers: {
            Host: "organizer.example",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": {
                  name: "modern-test",
                  version: "1",
                },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        result: {
          tools?: { name: string }[];
          resources?: { uri: string }[];
          prompts?: { name: string }[];
        };
        error?: unknown;
      };
    };
    const tools = await call("tools/list");
    expect(tools.error).toBeUndefined();
    expect(tools.result.tools?.some((tool) => tool.name === "get_board")).toBe(
      true,
    );
    expect(
      tools.result.tools?.some((tool) => tool.name === "save_review"),
    ).toBe(false);
    const resources = await call("resources/list");
    expect(
      resources.result.resources?.some(
        (resource) => resource.uri === "organizer://board",
      ),
    ).toBe(true);
    const prompts = await call("prompts/list");
    expect(prompts.result.prompts).toHaveLength(5);
  });
});
