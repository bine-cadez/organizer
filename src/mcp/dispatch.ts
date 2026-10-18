import type {
  Actor,
  BookCandidate,
  CalendarRole,
  Snapshot,
} from "../shared/types";
import { effectiveScopes, toolByName } from "./registry";

export interface McpContext {
  actor: Actor;
  execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  snapshot: () => Promise<Snapshot>;
  searchBooks: (
    query: string,
    limit: number,
    cursor?: string,
  ) => Promise<unknown>;
  getBookCandidate: (input: {
    editionId?: string;
    isbn?: string;
  }) => Promise<BookCandidate>;
  connectUrl: (role: CalendarRole) => string;
  origin: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

class ToolError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateCombination(name: string, args: Record<string, unknown>) {
  if (name === "list_tickets" && !args.projectId && !args.date)
    throw new ToolError("VALIDATION_ERROR", "A projectId or date is required.");
  if (
    name === "get_book_candidate" &&
    Number(Boolean(args.editionId)) + Number(Boolean(args.isbn)) !== 1
  )
    throw new ToolError(
      "VALIDATION_ERROR",
      "Supply exactly one editionId or ISBN.",
    );
  if (name === "list_bookings") {
    const ticket = Boolean(args.ticketId);
    if (
      (ticket && (args.start || args.end)) ||
      (!ticket && (!args.start || !args.end))
    )
      throw new ToolError(
        "VALIDATION_ERROR",
        "Supply a ticketId or one start/end range.",
      );
  }
  if (
    ["list_calendar_events", "list_bookings"].includes(name) &&
    args.start &&
    args.end
  ) {
    const length =
      Date.parse(String(args.end)) - Date.parse(String(args.start));
    if (length <= 0 || length > 31 * 86400000)
      throw new ToolError(
        "VALIDATION_ERROR",
        "Calendar ranges must be positive and at most 31 days.",
      );
  }
}

const sensitiveKey = /(?:token|credential|secret|password|authorization)/i;
const eventTextKey =
  /^(?:title|summary|description|location|attendees|organizer|creator|htmlLink|hangoutLink|conferenceData)$/i;
const eventArrayKey = /^(?:events|calendarEvents|externalEvents|conflicts)$/i;

/** Defense in depth after engine scope checks: no provider credentials or external text leaks. */
function redact(
  value: unknown,
  options: {
    calendar: boolean;
    details: boolean;
    parent?: string;
    audit?: boolean;
  },
  event = false,
): unknown {
  if (Array.isArray(value))
    return value.map((entry) => redact(entry, options, event));
  if (!object(value)) return value;
  const eventLike =
    event ||
    (typeof value.googleEventId === "string" && !("ticketId" in value)) ||
    ("start" in value &&
      "end" in value &&
      ("role" in value || "isBusy" in value || "allDay" in value)) ||
    (value.role === "work" && ("title" in value || "summary" in value));
  if (eventLike && !options.calendar) return undefined;
  const clean: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) continue;
    if (eventLike && !options.details && eventTextKey.test(key)) continue;
    if (
      options.audit &&
      /^(?:arguments|payload|request|response|learning|text|description)$/i.test(
        key,
      )
    )
      continue;
    if (key === "learnings") {
      if (!options.parent) continue;
      const belongs = (entry: unknown) =>
        object(entry) &&
        (entry.projectId === options.parent ||
          entry.bookId === options.parent ||
          (object(entry.target) && entry.target.id === options.parent));
      if (Array.isArray(child))
        clean[key] = child
          .filter(belongs)
          .map((entry) => redact(entry, options));
      else if (object(child) && Array.isArray(child.items))
        clean[key] = {
          ...child,
          items: child.items
            .filter(belongs)
            .map((entry) => redact(entry, options)),
        };
      continue;
    }
    const eventChildren = eventArrayKey.test(key);
    if (eventChildren && !options.calendar) {
      clean[key] = [];
      continue;
    }
    const result = redact(child, options, eventChildren);
    if (result !== undefined)
      clean[key] = Array.isArray(result)
        ? result.filter((entry) => entry !== undefined)
        : result;
  }
  if (eventLike && !options.details) clean.title = "Busy";
  return clean;
}

function summary(result: Record<string, unknown>, name: string): string {
  if (object(result.data) && typeof result.data.summary === "string")
    return result.data.summary;
  return `${name.replaceAll("_", " ")} completed. See the structured result for current data and synchronization status.`;
}

function resultFromError(
  error: unknown,
  name: string,
  hasCalendarDetails: boolean,
): ToolResult {
  const known =
    object(error) &&
    typeof error.code === "string" &&
    /^[A-Z_]+$/.test(error.code);
  const code = known ? String(error.code) : "INTERNAL_ERROR";
  let message =
    known && error instanceof Error
      ? error.message
      : "Organizer could not complete this request. Try again or inspect the current state.";
  if (code === "BOOKING_CONFLICT")
    message = "That interval overlaps busy time.";
  const details =
    known && object(error.details)
      ? redact(error.details, { calendar: true, details: hasCalendarDetails })
      : {};
  const payload = {
    error: {
      code,
      message,
      details,
      retryable: known && error.retryable === true,
    },
    requestId: crypto.randomUUID(),
  };
  return {
    isError: true,
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

/** Used by both HTTP commands and MCP. The engine remains the sole writer/domain authority. */
export async function executeTool(
  name: string,
  input: unknown,
  context: McpContext,
): Promise<ToolResult> {
  const scopes = effectiveScopes(context.actor.scopes);
  try {
    const tool = toolByName.get(name);
    if (!tool) throw new ToolError("NOT_FOUND", "Unknown Organizer tool.");
    const missing = tool.scopes.filter((scope) => !scopes.has(scope));
    if (missing.length)
      throw new ToolError(
        "MISSING_SCOPE",
        "This client is not authorized for that operation.",
        { requiredScopes: [...new Set(missing)] },
      );
    const parsed = tool.inputSchema.safeParse(input);
    if (!parsed.success)
      throw new ToolError("VALIDATION_ERROR", "The tool input is invalid.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path,
          message: issue.message,
        })),
      });
    const args = parsed.data as Record<string, unknown>;
    validateCombination(name, args);
    if (
      name === "list_calendar_events" &&
      args.detail === "titles" &&
      !scopes.has("calendar:details:read")
    )
      throw new ToolError(
        "MISSING_SCOPE",
        "Calendar titles require calendar:details:read.",
        { requiredScopes: ["calendar:details:read"] },
      );

    let raw: unknown;
    if (name === "search_books")
      raw = await context.searchBooks(
        String(args.query),
        Number(args.limit ?? 10),
        args.cursor as string | undefined,
      );
    else if (name === "get_book_candidate")
      raw = await context.getBookCandidate(
        args as { editionId?: string; isbn?: string },
      );
    else {
      if (
        name === "queue_book" &&
        object(args.source) &&
        args.source.type === "open_library"
      ) {
        // Check a committed receipt before depending on the external provider again.
        try {
          raw = await context.execute(name, args);
        } catch (error) {
          if (!object(error) || error.code !== "BOOK_METADATA_INCOMPLETE")
            throw error;
          const candidate = await context.getBookCandidate({
            editionId: String(args.source.editionId),
          });
          // A new command's first attempt rolled back. Only this trusted adapter may supply metadata.
          raw = await context.execute(name, {
            ...args,
            _resolvedBook: candidate,
          });
        }
      } else raw = await context.execute(name, args);
    }

    let envelope: Record<string, unknown>;
    if (object(raw) && "data" in raw && object(raw.meta)) envelope = raw;
    else {
      const snapshot = await context.snapshot();
      envelope = {
        data: raw,
        meta: {
          asOf: new Date().toISOString(),
          timezone: snapshot.timezone,
          ownerRevision: snapshot.ownerRevision,
          versions: snapshot.versions,
          warnings: [],
        },
      };
    }
    if (name === "get_calendar_connect_link") {
      const data = object(envelope.data) ? envelope.data : {};
      envelope = {
        ...envelope,
        data: {
          ...data,
          role: args.role,
          href: context.connectUrl(args.role as CalendarRole),
        },
      };
    }
    const clean = redact(envelope, {
      calendar: scopes.has("calendar:busy:read"),
      details:
        scopes.has("calendar:details:read") &&
        (name !== "list_calendar_events" || args.detail === "titles"),
      parent: name === "get_item" ? String(args.itemId) : undefined,
      audit: name === "list_changes",
    }) as Record<string, unknown>;
    const description = summary(clean, name);
    // Serialize the sanitized result only; the original provider payload never enters text content.
    return {
      structuredContent: clean,
      content: [
        { type: "text", text: `${description}\n${JSON.stringify(clean)}` },
      ],
    };
  } catch (error) {
    return resultFromError(error, name, scopes.has("calendar:details:read"));
  }
}
