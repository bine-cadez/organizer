#!/usr/bin/env node
// Mutates an empty, isolated local Wrangler store. Never run against the preview store.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = new URL(
  process.env.ORGANIZER_SMOKE_URL || "http://127.0.0.1:8788",
);
assert(
  ["http:", "https:"].includes(base.protocol),
  "Smoke tests require HTTP(S).",
);
assert(
  ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname),
  "Refusing a non-loopback smoke target.",
);
assert.notEqual(
  base.port,
  "8787",
  "Port 8787 is the preview store; use isolated Wrangler on 8788.",
);
assert(
  !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    base.pathname === "/",
  "Use an origin URL without credentials, path, query, or fragment.",
);
const origin = base.origin;
const runId = randomUUID().slice(0, 8);
let assertions = 0;
function check(condition, description) {
  assert(condition, description);
  assertions++;
  console.log(`  ✓ ${description}`);
}
async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}
async function state() {
  const r = await request("/api/state");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function send(tool, args) {
  return request(`/api/commands/${tool}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Organizer-Request": "1",
      Origin: origin,
    },
    body: JSON.stringify(args),
  });
}
async function read(tool, args = {}) {
  const r = await send(tool, args);
  assert.equal(r.status, 200, `${tool}: ${JSON.stringify(r.body)}`);
  assert(!r.body.error, `${tool}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function mutationArgs(args = {}) {
  const s = await state();
  return {
    idempotencyKey: `smoke-${runId}-${randomUUID()}`,
    expectedVersions: {
      ...s.versions,
      [`review:${s.reviewDate}`]: s.versions[`review:${s.reviewDate}`] || "0",
    },
    ...args,
  };
}
async function apply(tool, args = {}) {
  const r = await send(tool, await mutationArgs(args));
  assert.equal(r.status, 200, `${tool}: ${JSON.stringify(r.body)}`);
  assert(!r.body.error, `${tool}: ${JSON.stringify(r.body)}`);
  return r.body.data;
}
async function rejected(tool, args, code) {
  const r = await send(tool, await mutationArgs(args));
  check(
    r.status >= 400 && r.body.error?.code === code,
    `${tool} rejects with ${code}`,
  );
  return r;
}
const findItem = (s, id) => s.items.find((item) => item.id === id);

console.log(`Organizer HTTP smoke: ${origin} (isolated empty store required)`);
const session = await request("/api/session");
check(
  session.status === 200 &&
    session.body.authenticated &&
    session.body.localDevelopment,
  "local development identity is active",
);
const initial = await state();
for (const field of [
  "items",
  "tickets",
  "learnings",
  "bookings",
  "connections",
  "events",
  "operations",
  "reviews",
])
  assert.deepEqual(
    initial[field],
    [],
    `Refusing to modify a nonempty store: ${field}`,
  );
check(
  initial.areas.length === 4,
  "empty database seeds exactly four fixed areas",
);

const csrf = await request("/api/commands/queue_project", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ areaId: "tech", title: "Must not exist" }),
});
check(
  csrf.status === 403 && csrf.body.error?.code === "CSRF_REJECTED",
  "browser write without request header is denied",
);
const crossSite = await request("/api/commands/queue_project", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Organizer-Request": "1",
    Origin: "https://untrusted.example",
  },
  body: JSON.stringify({ areaId: "tech", title: "Must not exist" }),
});
check(
  crossSite.status === 403 && crossSite.body.error?.code === "CSRF_REJECTED",
  "cross-origin browser write is denied",
);
const board = await read("get_board");
check(
  board.areas.length === 4 &&
    board.areas.every(
      (area) => area.places.project === null && area.places.book === null,
    ),
  "Board begins with eight open places",
);

const first = (
  await apply("queue_project", {
    areaId: "tech",
    title: `Smoke project ${runId}`,
    goal: "Exercise persisted HTTP workflows.",
  })
).item;
check(
  Boolean(first?.id) && first.state === "queued",
  "queue project returns a persisted queued item",
);
await apply("start_item", { itemId: first.id });
const firstTicket = (
  await apply("create_ticket", {
    projectId: first.id,
    title: "Smoke ticket before swap",
  })
).ticket;
await apply("set_ticket_status", {
  ticketId: firstTicket.id,
  status: "in_progress",
});
check(
  (await state()).tickets.find((ticket) => ticket.id === firstTicket.id)
    ?.status === "in_progress",
  "ticket status persists through real HTTP",
);
const next = (
  await apply("queue_project", {
    areaId: "tech",
    title: `Smoke replacement ${runId}`,
  })
).item;
await rejected("start_item", { itemId: next.id }, "PLACE_RESERVED");
const beforePreview = await state();
const preview = await send("replace_active_item", {
  mode: "preview",
  currentItemId: first.id,
  nextItemId: next.id,
  disposition: "pause",
});
check(
  preview.status === 200 && preview.body.data?.outcome === "preview",
  "place replacement preview returns concrete guarded effects",
);
assert.deepEqual(
  await state(),
  beforePreview,
  "Preview must not persist any domain effect.",
);
await apply("replace_active_item", {
  currentItemId: first.id,
  nextItemId: next.id,
  disposition: "pause",
});
const swapped = await state();
check(
  findItem(swapped, first.id)?.state === "paused" &&
    findItem(swapped, next.id)?.state === "active" &&
    swapped.items.filter(
      (item) =>
        item.areaId === "tech" &&
        item.kind === "project" &&
        item.state === "active",
    ).length === 1,
  "atomic swap leaves one holder and pauses the previous item",
);
check(
  swapped.tickets.find((ticket) => ticket.id === firstTicket.id)?.status ===
    "todo",
  "pause resets in-progress work to To do",
);
await rejected("resume_item", { itemId: first.id }, "PLACE_RESERVED");

const context = await read("get_context");
const todayTicket = (
  await apply("create_ticket", {
    projectId: next.id,
    title: "Finish in the review",
  })
).ticket;
await apply("set_ticket_day", {
  ticketId: todayTicket.id,
  plannedFor: context.reviewDate,
});
const book = (
  await apply("queue_book", {
    areaId: "self",
    source: {
      type: "manual",
      title: `Smoke manual book ${runId}`,
      authors: ["Smoke author"],
      pageCount: 100,
    },
  })
).item;
await apply("start_item", { itemId: book.id });
await apply("set_book_progress", { bookId: book.id, currentPage: 42 });
check(
  findItem(await state(), book.id)?.currentPage === 42,
  "manual book queue, start, and page progress persist",
);
const learning = await apply("add_learning", {
  text: "HTTP requests use the same guarded domain commands.",
  target: { kind: "project", id: next.id },
});
check(
  Boolean(learning.learning?.id) &&
    (await state()).learnings.some(
      (entry) =>
        entry.id === learning.learning.id &&
        entry.createdOn === context.localDate,
    ),
  "direct learning uses server local date and the selected active parent",
);

const review = await read("get_review", { date: context.reviewDate });
assert(
  review.eligible && !review.final,
  "The isolated store must have an eligible unsaved review.",
);
const completedTicketIds = review.tickets.map((ticket) => ticket.id);
await apply("update_review_draft", {
  date: context.reviewDate,
  patch: {
    completedTicketIds,
    slippedDestinations: [],
    bookPages: [{ bookId: book.id, currentPage: 75 }],
    markReadBookIds: [],
    learning: {
      text: "The final review commits once across browser and agents.",
      target: { kind: "book", id: book.id },
    },
  },
});
const drafted = await state();
check(
  drafted.tickets.find((ticket) => ticket.id === todayTicket.id)?.status ===
    "todo" &&
    findItem(drafted, book.id)?.currentPage === 42 &&
    drafted.learnings.length === 1 &&
    drafted.operations.length === 0,
  "durable review draft has no ticket, page, learning, or calendar side effects",
);
const saveArgs = await mutationArgs({ date: context.reviewDate });
const saved = await send("save_review", saveArgs);
assert.equal(saved.status, 200, JSON.stringify(saved.body));
const afterSave = await state();
check(
  afterSave.reviews.find((entry) => entry.date === context.reviewDate)
    ?.savedAt &&
    afterSave.tickets.find((ticket) => ticket.id === todayTicket.id)?.status ===
      "done" &&
    findItem(afterSave, book.id)?.currentPage === 75 &&
    afterSave.learnings.length === 2,
  "review Save atomically commits final snapshot, ticket, pages, and one learning",
);
const replay = await send("save_review", saveArgs);
check(
  replay.status === 200 && replay.body.data?.deduplicated === true,
  "exact review Save retry returns its idempotent receipt",
);
assert.deepEqual(
  await state(),
  afterSave,
  "Exact Save replay must not change versions or duplicate effects.",
);
await rejected(
  "save_review",
  { date: context.reviewDate },
  "REVIEW_ALREADY_SAVED",
);
await rejected(
  "update_review_draft",
  { date: context.reviewDate, patch: { learning: null } },
  "REVIEW_ALREADY_SAVED",
);

// A current open ticket proves booking is blocked by missing credentials without contacting Google.
const unbooked = (
  await apply("create_ticket", {
    projectId: next.id,
    title: "No Google calls from smoke",
  })
).ticket;
const tomorrow = new Date(`${context.localDate}T12:00:00Z`);
tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
const date = tomorrow.toISOString().slice(0, 10);
await rejected(
  "book_ticket",
  {
    ticketId: unbooked.id,
    start: `${date}T08:00:00+02:00`,
    end: `${date}T09:00:00+02:00`,
    allowOverlap: false,
  },
  "RECONNECT_REQUIRED",
);
check(
  (await state()).connections.length === 0 &&
    (await state()).operations.length === 0,
  "smoke never connects Google or creates provider work",
);

let rpcId = 0;
// initialize/initialized are the legacy handshake; modern MCP uses per-request metadata instead.
let protocolVersion = "2025-11-25";
async function rpc(method, params = {}, notification = false) {
  const id = notification ? undefined : ++rpcId;
  const r = await request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Origin: origin,
      "MCP-Protocol-Version": protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      params,
    }),
  });
  if (notification && [200, 202, 204].includes(r.status)) return null;
  assert.equal(r.status, 200, `MCP ${method}: ${JSON.stringify(r.body)}`);
  let messages;
  if (typeof r.body === "string")
    messages = r.body
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()));
  else messages = [r.body];
  const result = messages.find((message) => message.id === id);
  assert(result && !result.error, `MCP ${method}: ${JSON.stringify(messages)}`);
  return result.result;
}
const initialized = await rpc("initialize", {
  protocolVersion,
  capabilities: {},
  clientInfo: { name: "organizer-local-smoke", version: "1.0.0" },
});
assert(
  typeof initialized.protocolVersion === "string",
  "MCP initialize must negotiate a protocol.",
);
protocolVersion = initialized.protocolVersion;
await rpc("notifications/initialized", {}, true);
check(
  Boolean(initialized.serverInfo?.name),
  `MCP initializes over HTTP (${protocolVersion})`,
);
const tools = await rpc("tools/list");
check(
  tools.tools?.length === 47 &&
    new Set(tools.tools.map((tool) => tool.name)).size === 47,
  "actual MCP endpoint advertises exactly 47 unique tools",
);
const mcpBoard = await rpc("tools/call", { name: "get_board", arguments: {} });
check(
  !mcpBoard.isError &&
    mcpBoard.structuredContent?.data?.areas?.some(
      (area) => area.id === "tech" && area.places.project?.id === next.id,
    ),
  "MCP tool call reads the same persisted holder as the browser API",
);
const mcpLearning = await rpc("tools/call", {
  name: "add_learning",
  arguments: await mutationArgs({
    text: "MCP shares the persisted command engine.",
    target: { kind: "project", id: next.id },
  }),
});
check(
  !mcpLearning.isError && (await state()).learnings.length === 3,
  "authorized MCP mutation persists through the actual HTTP endpoint",
);
console.log(
  `\nPassed ${assertions} HTTP checks. Test data remains only in isolated ${origin}; Google was not contacted.`,
);
