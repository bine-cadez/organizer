import { z } from "zod";

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  scopes: readonly string[];
  readOnly: boolean;
  destructive: boolean;
  openWorld: boolean;
}

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_:-]+$/);
const title = z.string().trim().min(1).max(120);
const text = z.string().trim().min(1).max(2000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T12:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Use a valid calendar date in YYYY-MM-DD format.");
const instant = z.string().datetime({ offset: true });
const area = z.enum(["tech", "sales", "ship", "self"]);
const kind = z.enum(["project", "book"]);
const state = z.enum(["queued", "active", "paused", "archived", "done"]);
const status = z.enum(["todo", "in_progress", "done", "closed"]);
const role = z.enum(["personal", "work"]);
const pageCount = z.number().int().positive().max(100000);
const author = z.string().trim().min(1).max(200);
const editionId = z.string().regex(/^\/books\/OL\d+M$/);
const isbn = z
  .string()
  .max(24)
  .refine(
    (value) => /^(?:\d{9}[\dXx]|\d{13})$/.test(value.replace(/[ -]/g, "")),
    "Use a 10- or 13-character ISBN.",
  );
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), id }).strict(),
  z.object({ kind: z.literal("book"), id }).strict(),
]);
const pagination = {
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
};
const versions = z.record(
  z.string().min(1).max(240),
  z.string().min(1).max(160),
);
const commonMutation = {
  mode: z.enum(["apply", "preview"]).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  expectedVersions: versions.optional(),
};

function read(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  scopes: string[] = [],
  openWorld = false,
): ToolDefinition {
  return {
    name,
    title: name.replaceAll("_", " "),
    description,
    inputSchema: z.object(shape).strict(),
    scopes: ["organizer:read", ...scopes],
    readOnly: true,
    destructive: false,
    openWorld,
  };
}

function mutation(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  scope: string,
  destructive = false,
  openWorld = false,
): ToolDefinition {
  return {
    name,
    title: name.replaceAll("_", " "),
    description,
    inputSchema: z
      .object({ ...shape, ...commonMutation })
      .strict()
      .superRefine((args, ctx) => {
        if (args.mode !== "preview") {
          if (!args.idempotencyKey)
            ctx.addIssue({
              code: "custom",
              path: ["idempotencyKey"],
              message:
                "Apply requires a unique idempotencyKey; retry with exactly the original arguments.",
            });
          if (!args.expectedVersions)
            ctx.addIssue({
              code: "custom",
              path: ["expectedVersions"],
              message:
                "Apply requires expectedVersions returned by a read or preview.",
            });
        }
      }),
    scopes: ["organizer:read", scope],
    readOnly: false,
    destructive,
    openWorld,
  };
}

const itemInput = { itemId: id };
const operationInput = { operationId: id };
const interval = { start: instant, end: instant };
const bookingInput = {
  ...interval,
  allowOverlap: z.boolean(),
  acceptIncompleteAvailability: z.boolean().optional(),
};
const destination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tomorrow_unbooked") }).strict(),
  z.object({ kind: z.literal("back_to_todo") }).strict(),
  z
    .object({ kind: z.literal("book"), ...interval, allowOverlap: z.boolean() })
    .strict(),
]);
const draftPatch = z
  .object({
    completedTicketIds: z.array(id).max(500).optional(),
    slippedDestinations: z
      .array(z.object({ ticketId: id, destination }).strict())
      .max(500)
      .optional(),
    bookPages: z
      .array(
        z
          .object({
            bookId: id,
            currentPage: z.number().int().min(0).max(100000),
          })
          .strict(),
      )
      .max(4)
      .optional(),
    markReadBookIds: z.array(id).max(4).optional(),
    learning: z.object({ text, target }).strict().nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Supply at least one draft field.",
  );

/** The same strict catalog drives HTTP dispatch and MCP discovery. */
export const toolDefinitions: readonly ToolDefinition[] = [
  read(
    "get_context",
    "Read fixed Ljubljana timezone, current local/review date, rules, capabilities and integration status.",
    {},
  ),
  read(
    "get_today",
    "Read an explicit local day or today; external calendars are redacted to granted detail.",
    { date: date.optional() },
  ),
  read(
    "get_board",
    "Read the eight places, current holders, ordered Up next and revision tokens.",
    {},
  ),
  read(
    "list_items",
    "List project/book titles and summaries; does not search learning text.",
    {
      kind: kind.optional(),
      areaId: area.optional(),
      states: z.array(state).min(1).max(5).optional(),
      query: z.string().trim().min(2).max(200).optional(),
      ...pagination,
    },
  ),
  read(
    "get_item",
    "Read one project/book and only its attached learnings, plus permitted actions and revisions.",
    { itemId: id, ...pagination },
  ),
  mutation(
    "queue_project",
    "Queue a project and optional To do tickets atomically; requires destination queue revision.",
    {
      areaId: area,
      title,
      goal: z.string().trim().max(500).optional(),
      initialTicketTitles: z.array(title).max(50).optional(),
    },
    "organizer:write",
  ),
  mutation(
    "update_project",
    "Edit project title/goal; archived/done are read-only. Requires item revision.",
    {
      projectId: id,
      patch: z
        .object({
          title: title.optional(),
          goal: z.string().trim().max(500).nullable().optional(),
        })
        .strict()
        .refine(
          (value) => Object.keys(value).length > 0,
          "Supply a metadata field.",
        ),
    },
    "organizer:write",
  ),
  mutation(
    "start_item",
    "Start a queued item only in an open matching place; requires item/place revisions. No override.",
    itemInput,
    "lifecycle:write",
  ),
  mutation(
    "pause_item",
    "Pause an active item, open its place, reset in-progress tickets and stage future booking cleanup.",
    itemInput,
    "lifecycle:write",
    true,
    true,
  ),
  mutation(
    "finish_item",
    "Finish an active item, close project open tickets or complete book pages, and stage future booking cleanup.",
    itemInput,
    "lifecycle:write",
    true,
    true,
  ),
  mutation(
    "archive_item",
    "Archive an active item, open its place and stage future booking cleanup; archived item becomes read-only.",
    itemInput,
    "lifecycle:write",
    true,
    true,
  ),
  mutation(
    "resume_item",
    "Resume a paused item only if its matching place is open. No automatic rebooking.",
    itemInput,
    "lifecycle:write",
  ),
  mutation(
    "restore_item",
    "Restore an archived item to the end of Up next; done items cannot reopen.",
    itemInput,
    "lifecycle:write",
  ),
  mutation(
    "replace_active_item",
    "Atomically pause/finish/archive the holder then start queued next in the same area and kind. Requires both item/place/queue revisions.",
    {
      currentItemId: id,
      nextItemId: id,
      disposition: z.enum(["pause", "finish", "archive"]),
    },
    "lifecycle:write",
    true,
    true,
  ),
  mutation(
    "reorder_up_next",
    "Move one queued item within its area; beforeItemId null appends. Requires queue revision.",
    { areaId: area, itemId: id, beforeItemId: id.nullable() },
    "organizer:write",
  ),
  read(
    "list_tickets",
    "Read tickets for one project or local date; at least one filter is required.",
    {
      projectId: id.optional(),
      date: date.optional(),
      statuses: z.array(status).min(1).max(4).optional(),
      booked: z.boolean().optional(),
      ...pagination,
    },
  ),
  read(
    "get_ticket",
    "Read ticket, parent state, current booking, actions and revisions.",
    { ticketId: id },
  ),
  mutation(
    "create_ticket",
    "Append a To do ticket to an editable project; no standalone tickets or estimates.",
    { projectId: id, title },
    "organizer:write",
  ),
  mutation(
    "update_ticket",
    "Edit ticket title without changing calendar times/ownership; historical events stay unchanged.",
    { ticketId: id, title },
    "organizer:write",
  ),
  mutation(
    "set_ticket_status",
    "Change active-project work status; closed is server-owned. Requires ticket and affected column revisions.",
    {
      ticketId: id,
      status: z.enum(["todo", "in_progress", "done"]),
      beforeTicketId: id.nullable().optional(),
    },
    "organizer:write",
    true,
  ),
  mutation(
    "set_ticket_day",
    "Set or clear an active ticket local-day plan; does not create or move a calendar event.",
    { ticketId: id, plannedFor: date.nullable() },
    "organizer:write",
  ),
  mutation(
    "reorder_tickets",
    "Reorder a ticket in one column of its project; null appends. Requires ticket/column revisions.",
    { projectId: id, status, ticketId: id, beforeTicketId: id.nullable() },
    "organizer:write",
  ),
  read(
    "search_books",
    "Search Open Library by title, author or ISBN; on-demand cached lookup, maximum ten results.",
    {
      query: z.string().trim().min(2).max(200),
      cursor: pagination.cursor,
      limit: z.number().int().min(1).max(10).optional(),
    },
    [],
    true,
  ),
  read(
    "get_book_candidate",
    "Get a selected Open Library edition or ISBN with automatic cover and page-count provenance.",
    { editionId: editionId.optional(), isbn: isbn.optional() },
    [],
    true,
  ),
  mutation(
    "queue_book",
    "Import a verified Open Library edition or manual book into Up next; automatic cover or title card, no upload. Requires queue revision.",
    {
      areaId: area,
      source: z.discriminatedUnion("type", [
        z.object({ type: z.literal("open_library"), editionId }).strict(),
        z
          .object({
            type: z.literal("manual"),
            title,
            authors: z.array(author).max(20),
            pageCount,
          })
          .strict(),
      ]),
      pageCountOverride: pageCount.optional(),
    },
    "organizer:write",
    false,
    true,
  ),
  mutation(
    "update_book",
    "Edit book metadata; lowering page count clamps current page atomically.",
    {
      bookId: id,
      patch: z
        .object({
          title: title.optional(),
          authors: z.array(author).max(20).optional(),
          pageCount: pageCount.optional(),
        })
        .strict()
        .refine(
          (value) => Object.keys(value).length > 0,
          "Supply a metadata field.",
        ),
    },
    "organizer:write",
  ),
  mutation(
    "set_book_progress",
    "Set active book page within 0..pageCount; final page offers finishing, never auto-finishes.",
    { bookId: id, currentPage: z.number().int().min(0).max(100000) },
    "organizer:write",
  ),
  read(
    "list_calendar_events",
    "Read at most 31 days of cached calendars with account freshness; busy-only grants never receive titles.",
    {
      ...interval,
      roles: z.array(role).min(1).max(2).optional(),
      detail: z.enum(["busy", "titles"]).optional(),
      ...pagination,
    },
    ["calendar:busy:read"],
  ),
  read(
    "find_free_starts",
    "Find up to four starts fitting the requested length; refreshed availability is not a reservation.",
    {
      date,
      from: instant.optional(),
      lengthMinutes: z
        .number()
        .int()
        .min(15)
        .max(960)
        .multipleOf(15)
        .optional(),
      excludeBookingId: id.optional(),
    },
    ["calendar:busy:read"],
  ),
  read(
    "list_bookings",
    "Read Organizer current/historical bookings by ticket or bounded time range; no external descriptions.",
    {
      ticketId: id.optional(),
      start: instant.optional(),
      end: instant.optional(),
      ...pagination,
    },
  ),
  mutation(
    "book_ticket",
    "Book an active-project ticket on Personal only; 15-minute grid and one local day 07:00–23:00. Explicit overlap policy, durable pending sync.",
    { ticketId: id, ...bookingInput },
    "calendar:book",
    false,
    true,
  ),
  mutation(
    "move_booking",
    "Move current upcoming/ongoing Organizer booking on Personal; preserve identity and require booking/ticket revisions.",
    { bookingId: id, ...bookingInput },
    "calendar:book",
    true,
    true,
  ),
  mutation(
    "resize_booking",
    "Resize current Organizer booking end by 15 minutes, minimum 15 minutes, no overlap, latest 23:00.",
    { bookingId: id, end: instant },
    "calendar:book",
    true,
    true,
  ),
  mutation(
    "remove_booking",
    "Remove current Organizer booking with durable provider deletion; keep historical occurrence records.",
    { bookingId: id },
    "calendar:book",
    true,
    true,
  ),
  mutation(
    "add_learning",
    "Append 1–2000 characters to exactly one active project/book; server sets today in Ljubljana. No global learning feed or update/delete.",
    { text, target },
    "organizer:write",
  ),
  read(
    "get_review",
    "Read eligible unsaved review context/draft or a saved final receipt; fixed Ljubljana 04:00 cutoff, no catch-up.",
    { date: date.optional() },
  ),
  mutation(
    "update_review_draft",
    "Stage fields on the eligible unsaved review only. Book choices stay in draft; no domain/calendar effects before Save.",
    { date, patch: draftPatch },
    "review:write",
  ),
  mutation(
    "save_review",
    "Save eligible review once atomically; at most one review learning. Saved reviews are final; exact idempotent retries return original receipt.",
    { date },
    "review:write",
    true,
    true,
  ),
  mutation(
    "dismiss_skipped_review_note",
    "Dismiss eligible missed-review note for this local day without creating a review or streak.",
    { date },
    "organizer:write",
  ),
  read(
    "get_connections",
    "Read Personal/Work connection and calendar summaries without credentials.",
    {},
  ),
  read(
    "get_calendar_sync",
    "Read account freshness, pending/failed counts and reconnect state.",
    { role: role.optional() },
  ),
  mutation(
    "request_calendar_sync",
    "Schedule/coalesce bounded read sync for selected account roles; return durable operation status.",
    { role: role.optional() },
    "calendar:busy:read",
    false,
    true,
  ),
  read(
    "get_calendar_connect_link",
    "Return owner browser connect/reconnect URL; no tokens are accepted or returned.",
    { role },
  ),
  read(
    "get_operation",
    "Read durable provider operation status, attempts, failure and recovery hints.",
    operationInput,
  ),
  mutation(
    "retry_operation",
    "Retry an authorized failed operation after prerequisites; scopes of its original action are checked again.",
    operationInput,
    "organizer:read",
    false,
    true,
  ),
  mutation(
    "undo_booking_change",
    "Compensate failed create/move/resize safely; reconcile ambiguous create before claiming remote absence. Failed deletes are retry-only.",
    operationInput,
    "calendar:book",
    true,
    true,
  ),
  read(
    "list_changes",
    "Read bounded redacted audit receipts, never a global feed of learning/calendar text.",
    {
      since: instant.optional(),
      until: instant.optional(),
      entityId: id.optional(),
      ...pagination,
    },
    ["audit:read"],
  ),
];

export const toolByName = new Map(
  toolDefinitions.map((tool) => [tool.name, tool]),
);

export function effectiveScopes(scopes: readonly string[]): Set<string> {
  const result = new Set(scopes);
  if (result.has("calendar:details:read") || result.has("calendar:book"))
    result.add("calendar:busy:read");
  return result;
}

export function permittedTools(scopes: readonly string[]): ToolDefinition[] {
  const granted = effectiveScopes(scopes);
  return toolDefinitions.filter((tool) =>
    tool.scopes.every((scope) => granted.has(scope)),
  );
}
