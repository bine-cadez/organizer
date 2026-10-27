import type {
  Actor,
  Area,
  Booking,
  CalendarEvent,
  CalendarRole,
  Connection,
  Item,
  Learning,
  Operation,
  Review,
  ReviewDraft,
  Snapshot,
  Ticket,
} from "../shared/types";
import { progressPercent } from "../shared/duration";
import { BOOK_INDEXES, BOOKS_DDL, SCHEMA } from "../storage/schema";
import { DomainError } from "./errors";
import {
  AUDIT_RETENTION_MS,
  CALENDAR_FUTURE_RETENTION_MS,
  CALENDAR_PAST_RETENTION_MS,
  CALENDAR_SYNC_FUTURE_MS,
  CALENDAR_SYNC_INTERVAL_MS,
  CALENDAR_SYNC_PAST_MS,
  CLEANUP_BATCH_LIMIT,
  CLEANUP_DAILY_ROW_BUDGET,
  OUTBOX_RETENTION_MS,
  RECEIPT_RETENTION_MS,
} from "./retention";
import {
  TIMEZONE,
  addDays,
  dayBounds,
  iso,
  localInstant,
  localParts,
  reviewDate,
} from "./time";
export { DomainError } from "./errors";
export type { Actor } from "../shared/types";
export interface DbPort {
  all(sql: string, ...bindings: any[]): any[];
  run(sql: string, ...bindings: any[]): void;
  transaction<T>(callback: () => T): T;
}
export interface AccountInput {
  id?: string;
  role: CalendarRole;
  email: string;
  encryptedCredentials: string;
  calendarIds?: string[];
  writeCalendarId?: string;
  googleSubject?: string;
}
export interface RemoteEvent {
  id?: string;
  googleEventId?: string;
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  startDate?: string;
  endDate?: string;
  isBusy?: boolean;
  etag?: string;
  deleted?: boolean;
}
export interface ReconcileInput {
  role: CalendarRole;
  calendarId: string;
  events: RemoteEvent[];
  syncToken?: string;
  syncedAt?: number;
  replace?: boolean;
  replaceRange?: { start: string; end: string };
  partial?: boolean;
}
type Row = Record<string, any>;
const AREAS: Area[] = [
  { id: "tech", code: "T", name: "Tech", fullName: "Tech Improvement" },
  {
    id: "sales",
    code: "S",
    name: "Sales & Business",
    fullName: "Sales / Business Improvement",
  },
  {
    id: "ship",
    code: "P",
    name: "Product Shipping",
    fullName: "Product Shipping",
  },
  {
    id: "self",
    code: "G",
    name: "General",
    fullName: "General Self-improvement",
  },
];
const MUTATIONS: Record<string, string> = {
  queue_project: "organizer:write",
  update_project: "organizer:write",
  reorder_up_next: "organizer:write",
  start_item: "lifecycle:write",
  pause_item: "lifecycle:write",
  finish_item: "lifecycle:write",
  archive_item: "lifecycle:write",
  resume_item: "lifecycle:write",
  restore_item: "lifecycle:write",
  replace_active_item: "lifecycle:write",
  create_ticket: "organizer:write",
  update_ticket: "organizer:write",
  set_ticket_status: "organizer:write",
  set_ticket_day: "organizer:write",
  reorder_tickets: "organizer:write",
  queue_book: "organizer:write",
  update_book: "organizer:write",
  set_book_progress: "organizer:write",
  add_learning: "organizer:write",
  book_ticket: "calendar:book",
  move_booking: "calendar:book",
  resize_booking: "calendar:book",
  remove_booking: "calendar:book",
  update_review_draft: "review:write",
  save_review: "review:write",
  dismiss_skipped_review_note: "organizer:write",
  request_calendar_sync: "calendar:busy:read",
  retry_operation: "",
  undo_booking_change: "calendar:book",
};
const READ_SCOPES: Record<string, string> = {
  list_calendar_events: "calendar:busy:read",
  find_free_starts: "calendar:busy:read",
  list_changes: "audit:read",
};
const terminal = new Set(["archived", "done"]);
const inactiveOps = new Set(["succeeded", "failed", "superseded"]);
/** Earlier rows in these states hold later work on the same booking. claimOperation and earliestPendingAttempt share this list. */
const BLOCKING_OPERATION_STATES =
  "('pending','running','waiting_retry','needs_reconnect','failed')";
const uid = (prefix: string) =>
  prefix + "_" + crypto.randomUUID().replaceAll("-", "");
const canonical = (v: any): string =>
  JSON.stringify(
    v === undefined
      ? null
      : Array.isArray(v)
        ? v.map((x) => JSON.parse(canonical(x)))
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .filter((k) => v[k] !== undefined)
                .map((k) => [k, JSON.parse(canonical(v[k]))]),
            )
          : v,
  );
const parse = <T = any>(s: string | null | undefined, fallback: any): T =>
  s ? JSON.parse(s) : fallback;
class Preview {
  constructor(public result: unknown) {}
}

export class OrganizerEngine {
  private now: () => number;
  private ctx?: {
    actor: Actor;
    tool: string;
    args: Row;
    at: number;
    commandId: string;
    before: Record<string, string>;
    required: Record<string, string>;
    touched: Set<string>;
    operations: string[];
    entities: string[];
    preview: boolean;
    /** System maintenance. Touches bump only rows that existed before the command. */
    system?: boolean;
    watermark?: Record<string, number>;
  };
  constructor(
    private db: DbPort,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    // workerd opens an implicit transaction on the first write and then ignores
    // PRAGMA foreign_keys until a later event. Read the books shape first, and
    // disable foreign keys before any write when a v1 table has to be rebuilt.
    const bookColumns = this.db
      .all("PRAGMA table_info(books)")
      .map((row) => String(row.name));
    const rebuildBooks =
      bookColumns.length > 0 && !bookColumns.includes("progress_unit");
    if (rebuildBooks) {
      this.db.run("PRAGMA foreign_keys=OFF");
      if (this.foreignKeysEnabled())
        throw new Error(
          "Could not disable foreign keys before rebuilding books. Existing books were left unchanged.",
        );
      // foreign_keys is connection-scoped, so a rollback leaves it off. Restore
      // it even when the schema transaction throws before the books rebuild.
      try {
        this.installSchema();
        this.rebuildBooksTable();
        this.recordSchema(2);
        this.recordSchema(3);
      } finally {
        this.db.run("PRAGMA foreign_keys=ON");
      }
    } else {
      this.installSchema();
      this.recordSchema(2);
      this.recordSchema(3);
    }
  }
  /**
   * Version 3 adds indexes for bounded calendar reads and bookkeeping purge.
   * CREATE INDEX IF NOT EXISTS does not rewrite existing rows.
   */
  private recordSchema(version: number) {
    this.db.run(
      "INSERT OR IGNORE INTO schema_versions(version,applied_at) VALUES(?,?)",
      version,
      this.now(),
    );
  }
  private installSchema() {
    this.db.transaction(() => {
      for (const sql of SCHEMA) this.db.run(sql);
      this.db.run(
        "INSERT OR IGNORE INTO schema_versions(version,applied_at) VALUES(1,?)",
        this.now(),
      );
      this.db.run(
        "INSERT OR IGNORE INTO settings(id,timezone,created_at) VALUES(1,?,?)",
        TIMEZONE,
        this.now(),
      );
      this.db.run(
        "INSERT OR IGNORE INTO aggregate_versions(key,version) VALUES('owner',1)",
      );
      for (const a of AREAS) {
        this.db.run(
          "INSERT OR IGNORE INTO areas(id,code,name,full_name) VALUES(?,?,?,?)",
          a.id,
          a.code,
          a.name,
          a.fullName,
        );
        for (const key of [
          `queue:${a.id}`,
          `place:${a.id}:project`,
          `place:${a.id}:book`,
        ])
          this.db.run(
            "INSERT OR IGNORE INTO aggregate_versions(key,version) VALUES(?,1)",
            key,
          );
      }
    });
  }
  private foreignKeysEnabled() {
    return Number(this.db.all("PRAGMA foreign_keys")[0]?.foreign_keys) === 1;
  }
  /**
   * Schema version 2 adds audiobook progress. Fresh databases already have the
   * columns from SCHEMA. A version-1 books table is rebuilt in place; every
   * existing row stays a page book. Foreign keys are turned off only for that
   * rebuild, because queue entries and learnings reference books. On workerd the
   * matching PRAGMA foreign_keys=ON is ignored until the next event;
   * OrganizerStore repeats it there and checks the readback.
   */
  private rebuildBooksTable() {
    try {
      this.db.transaction(() => {
        this.db.run(
          BOOKS_DDL.replace(
            "CREATE TABLE IF NOT EXISTS books(",
            "CREATE TABLE books__next(",
          ),
        );
        this.db.run(
          `INSERT INTO books__next(id,area_id,title,authors_json,work_id,edition_id,isbn,cover_url,cover_id,page_count,page_count_source,current_page,progress_unit,duration_minutes,position_minutes,state,started_at,paused_at,archived_at,done_at,created_at,updated_at,version)
           SELECT id,area_id,title,authors_json,work_id,edition_id,isbn,cover_url,cover_id,page_count,page_count_source,current_page,'pages',NULL,0,state,started_at,paused_at,archived_at,done_at,created_at,updated_at,version FROM books`,
        );
        this.db.run("DROP TABLE books");
        this.db.run("ALTER TABLE books__next RENAME TO books");
        for (const sql of BOOK_INDEXES) this.db.run(sql);
      });
    } finally {
      this.db.run("PRAGMA foreign_keys=ON");
    }
  }
  private at() {
    return this.ctx?.at ?? this.now();
  }
  private one(sql: string, ...values: any[]): Row | undefined {
    return this.db.all(sql, ...values)[0];
  }
  private fail(code: string, message: string, details: Row = {}): never {
    throw new DomainError(code, message, details);
  }
  private text(value: unknown, field: string, max = 120): string {
    if (
      typeof value !== "string" ||
      value.trim().length < 1 ||
      value.trim().length > max
    )
      this.fail(
        "VALIDATION_ERROR",
        `${field} must contain 1–${max} characters.`,
        { field },
      );
    return value.trim();
  }
  private integer(
    value: unknown,
    field: string,
    min: number,
    max: number,
  ): number {
    if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
      this.fail(
        "VALIDATION_ERROR",
        `${field} must be an integer between ${min} and ${max}.`,
        { field },
      );
    return Number(value);
  }
  /** Hours 0–999 and minutes 0–59. `minTotal` is 1 for a length and 0 for a position. */
  private clock(
    value: unknown,
    field: string,
    minTotal: number,
    maxTotal = 999 * 60 + 59,
  ): number {
    if (!value || typeof value !== "object" || Array.isArray(value))
      this.fail(
        "VALIDATION_ERROR",
        `${field} must include hours and minutes.`,
        { field },
      );
    const record = value as Row;
    if (Object.keys(record).some((key) => key !== "hours" && key !== "minutes"))
      this.fail(
        "VALIDATION_ERROR",
        `${field} only accepts hours and minutes.`,
        { field },
      );
    const hours = this.integer(record.hours, `${field}.hours`, 0, 999);
    const minutes = this.integer(record.minutes, `${field}.minutes`, 0, 59);
    const total = hours * 60 + minutes;
    if (total < minTotal)
      this.fail("VALIDATION_ERROR", `${field} must be at least 1 minute.`, {
        field,
      });
    if (total > maxTotal)
      this.fail(
        "VALIDATION_ERROR",
        maxTotal === 999 * 60 + 59
          ? `${field} must be at most 999 hours 59 minutes.`
          : `${field} must stay within the audiobook.`,
        { field },
      );
    return total;
  }
  private date(v: unknown): string {
    if (
      typeof v !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
      !Number.isFinite(Date.parse(v + "T12:00:00Z")) ||
      new Date(v + "T12:00:00Z").toISOString().slice(0, 10) !== v
    )
      this.fail("VALIDATION_ERROR", "A valid YYYY-MM-DD date is required.");
    return v;
  }
  private instant(v: unknown): number {
    if (
      typeof v !== "string" ||
      !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(v) ||
      !Number.isFinite(Date.parse(v))
    )
      this.fail(
        "VALIDATION_ERROR",
        "An explicit timestamp with offset is required.",
      );
    return Date.parse(v);
  }
  private area(v: unknown): string {
    if (!AREAS.some((x) => x.id === v))
      this.fail("VALIDATION_ERROR", "Unknown fixed area.");
    return String(v);
  }
  private item(id: unknown): Item {
    const p = this.one("SELECT * FROM projects WHERE id=?", String(id));
    if (p) return this.mapItem(p, "project");
    const b = this.one("SELECT * FROM books WHERE id=?", String(id));
    if (b) return this.mapItem(b, "book");
    return this.fail("NOT_FOUND", "Item not found.");
  }
  private ticket(id: unknown): Ticket {
    const r = this.one("SELECT * FROM tickets WHERE id=?", String(id));
    return r ? this.mapTicket(r) : this.fail("NOT_FOUND", "Ticket not found.");
  }
  private booking(id: unknown): Booking {
    const r = this.one("SELECT * FROM bookings WHERE id=?", String(id));
    return r
      ? this.mapBooking(r)
      : this.fail("NOT_FOUND", "Booking not found.");
  }
  private editable(item: Item) {
    if (terminal.has(item.state))
      this.fail("READ_ONLY_ITEM", "Archived and done items are read-only.");
  }
  private active(item: Item) {
    if (item.state !== "active")
      this.fail(
        "PROJECT_NOT_ACTIVE",
        "Start or resume the project before working or booking time.",
      );
  }
  private scope(actor: Actor, wanted: string) {
    if (actor.type === "system") return;
    const s = actor.scopes;
    if (
      s.includes(wanted) ||
      (wanted === "calendar:busy:read" &&
        (s.includes("calendar:details:read") || s.includes("calendar:book")))
    )
      return;
    this.fail("MISSING_SCOPE", `The ${wanted} scope is required.`, {
      requiredScope: wanted,
    });
  }
  private can(actor: Actor, wanted: string) {
    try {
      this.scope(actor, wanted);
      return true;
    } catch {
      return false;
    }
  }
  private need(key: string) {
    const c = this.ctx!;
    const current = c.before[key] ?? "0";
    c.required[key] = current;
    if (!c.preview && c.args.expectedVersions?.[key] !== current)
      this.fail(
        "VERSION_CONFLICT",
        "Read the current state and retry with its versions.",
        {
          currentVersions: { [key]: current },
          requiredVersions: { ...c.required },
        },
      );
  }
  private bumpAggregate(key: string) {
    if (this.ctx?.touched.has(key)) return;
    this.db.run(
      "INSERT INTO aggregate_versions(key,version) VALUES(?,1) ON CONFLICT(key) DO UPDATE SET version=version+1",
      key,
    );
    this.ctx?.touched.add(key);
  }
  private touch(table: string, id: string, key: string) {
    if (this.ctx?.touched.has(key)) return;
    if (this.existedBefore(table, id, key))
      this.db.run(
        `UPDATE ${table} SET version=version+1,updated_at=? WHERE id=?`,
        this.at(),
        id,
      );
    this.ctx?.touched.add(key);
    if (this.ctx && !this.ctx.entities.includes(id)) this.ctx.entities.push(id);
  }
  /**
   * User commands compare against the version map captured at the start.
   * System work captures only MAX(rowid) per table, which is a single index
   * probe, and bumps a row only when its rowid is inside that watermark.
   */
  private existedBefore(table: string, id: string, key: string): boolean {
    if (!this.ctx) return true;
    if (!this.ctx.system) return Boolean(this.ctx.before[key]);
    const row = this.one(`SELECT rowid AS n FROM ${table} WHERE id=?`, id);
    return row != null && Number(row.n) <= (this.ctx.watermark?.[table] ?? 0);
  }
  private watermarks(): Record<string, number> {
    const tables = [
      "projects",
      "books",
      "tickets",
      "bookings",
      "outbox_operations",
      "reviews",
    ];
    const out: Record<string, number> = {};
    for (const table of tables)
      out[table] = Number(
        this.one(`SELECT MAX(rowid) AS n FROM ${table}`)?.n ?? 0,
      );
    return out;
  }
  private itemTouch(item: Item) {
    this.touch(
      item.kind === "project" ? "projects" : "books",
      item.id,
      `item:${item.id}`,
    );
  }
  private mapItem(r: Row, kind: "project" | "book"): Item {
    const q = this.one(
      `SELECT position FROM queue_entries WHERE ${kind === "project" ? "project_id" : "book_id"}=?`,
      r.id,
    );
    return {
      id: r.id,
      kind,
      areaId: r.area_id,
      title: r.title,
      goal: r.goal ?? undefined,
      state: r.state,
      authors: kind === "book" ? parse(r.authors_json, []) : undefined,
      progressUnit: kind === "book" ? (r.progress_unit ?? "pages") : undefined,
      pageCount:
        kind === "book" && r.progress_unit === "time"
          ? undefined
          : r.page_count,
      pageCountSource:
        kind === "book" && r.progress_unit === "time"
          ? undefined
          : r.page_count_source,
      currentPage:
        kind === "book" && r.progress_unit === "time"
          ? undefined
          : r.current_page,
      durationMinutes:
        r.progress_unit === "time" ? r.duration_minutes : undefined,
      positionMinutes:
        r.progress_unit === "time" ? r.position_minutes : undefined,
      coverUrl: r.cover_url ?? undefined,
      workId: r.work_id ?? undefined,
      editionId: r.edition_id ?? undefined,
      isbn: r.isbn ?? undefined,
      order: q?.position,
      version: String(r.version),
      createdAt: iso(r.created_at)!,
      updatedAt: iso(r.updated_at)!,
      startedAt: iso(r.started_at),
      pausedAt: iso(r.paused_at),
      archivedAt: iso(r.archived_at),
      doneAt: iso(r.done_at),
    };
  }
  private mapTicket(r: Row): Ticket {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      status: r.status,
      plannedFor: r.planned_for ?? undefined,
      order: r.column_position,
      currentBookingId: r.current_booking_id ?? undefined,
      doneAt: iso(r.done_at),
      version: String(r.version),
    };
  }
  private mapBooking(r: Row): Booking {
    return {
      id: r.id,
      ticketId: r.ticket_id,
      accountId: r.account_id,
      start: iso(r.start_utc)!,
      end: iso(r.end_utc)!,
      googleEventId: r.google_event_id,
      calendarId: r.calendar_id,
      syncState: r.sync_state,
      desiredPresence: r.desired_presence,
      retiredAt: iso(r.retired_at),
      remoteStart: iso(r.remote_start_utc),
      remoteEnd: iso(r.remote_end_utc),
      version: String(r.version),
    };
  }
  private mapConnection(r: Row): Connection {
    return {
      id: r.id,
      role: r.role,
      email: r.email,
      status: r.status,
      lastSyncedAt: iso(r.last_synced_at),
      calendarIds: parse(r.calendar_ids_json, []),
      writeCalendarId: r.write_calendar_id ?? undefined,
      version: String(r.version),
    };
  }
  private mapOperation(r: Row): Operation {
    return {
      id: r.id,
      bookingId: r.booking_id ?? undefined,
      action: r.action,
      status: r.state,
      attempts: r.attempt_count,
      nextAttemptAt: iso(r.next_attempt_at),
      error: r.error_message ?? undefined,
      version: String(r.version),
    };
  }
  private versions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.all("SELECT * FROM aggregate_versions"))
      out[r.key] = String(r.version);
    for (const [table, prefix] of [
      ["projects", "item"],
      ["books", "item"],
      ["tickets", "ticket"],
      ["bookings", "booking"],
      ["outbox_operations", "operation"],
    ] as const)
      for (const r of this.db.all(`SELECT id,version FROM ${table}`))
        out[`${prefix}:${r.id}`] = String(r.version);
    for (const r of this.db.all("SELECT review_date,version FROM reviews"))
      out[`review:${r.review_date}`] = String(r.version);
    return out;
  }
  snapshot(): Snapshot {
    const at = this.at();
    const versions = this.versions();
    return {
      areas: AREAS,
      items: [
        ...this.db
          .all("SELECT * FROM projects ORDER BY created_at,id")
          .map((r) => this.mapItem(r, "project")),
        ...this.db
          .all("SELECT * FROM books ORDER BY created_at,id")
          .map((r) => this.mapItem(r, "book")),
      ],
      tickets: this.db
        .all(
          "SELECT * FROM tickets ORDER BY project_id,status,column_position,id",
        )
        .map((r) => this.mapTicket(r)),
      learnings: this.db
        .all("SELECT * FROM learnings ORDER BY created_on DESC,id")
        .map((r) => ({
          id: r.id,
          text: r.text,
          createdOn: r.created_on,
          projectId: r.project_id ?? undefined,
          bookId: r.book_id ?? undefined,
          sourceKind: r.source_kind,
          reviewId: r.review_id ?? undefined,
          createdBy: r.created_by_actor_id,
          version: String(r.version),
        })),
      bookings: this.db
        .all("SELECT * FROM bookings ORDER BY start_utc,id")
        .map((r) => this.mapBooking(r)),
      connections: this.db
        .all("SELECT * FROM calendar_accounts ORDER BY role")
        .map((r) => this.mapConnection(r)),
      events: this.eventProjection(),
      operations: this.db
        .all("SELECT * FROM outbox_operations ORDER BY created_at,id")
        .map((r) => this.mapOperation(r)),
      reviews: this.db
        .all("SELECT * FROM reviews ORDER BY review_date DESC")
        .map((r) => ({
          id: r.id,
          date: r.review_date,
          version: String(r.version),
          draft: parse(r.draft_json, undefined),
          saved: parse(r.saved_json, undefined),
          savedAt: iso(r.saved_at),
        })),
      versions,
      ownerRevision: versions.owner,
      timezone: TIMEZONE,
      localDate: localParts(at).date,
      reviewDate: reviewDate(at),
      setupSkipped: !!this.one("SELECT setup_skipped FROM settings WHERE id=1")
        ?.setup_skipped,
    };
  }
  /**
   * Reads the calendar mirror for one window. The default window is the
   * retention horizon (what the week view can still show). Callers that know
   * a tighter interval pass it so SQLite can satisfy the read from the
   * partial end/start indexes instead of the whole table.
   */
  private eventProjection(window?: {
    start: number;
    end: number;
  }): CalendarEvent[] {
    const at = this.at();
    const start = window?.start ?? at - CALENDAR_PAST_RETENTION_MS;
    const end = window?.end ?? at + CALENDAR_FUTURE_RETENTION_MS;
    const cutoff = at - 86400000;
    const startDate = localParts(start).date;
    const endDate = localParts(Math.max(start, end - 1)).date;
    const timed = this.db.all(
      `SELECT e.*,a.role,a.status,a.updated_at AS account_updated FROM calendar_events e JOIN calendar_accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL AND e.all_day=0 AND e.end_utc>? AND e.start_utc<? AND (a.status='connected' OR a.updated_at>?)`,
      start,
      end,
      cutoff,
    );
    const allDay = this.db.all(
      `SELECT e.*,a.role,a.status,a.updated_at AS account_updated FROM calendar_events e JOIN calendar_accounts a ON a.id=e.account_id WHERE e.deleted_at IS NULL AND e.all_day=1 AND e.end_date>? AND e.start_date<=? AND (a.status='connected' OR a.updated_at>?)`,
      startDate,
      endDate,
      cutoff,
    );
    return [...timed, ...allDay].map((r) => ({
      id: `${r.account_id}:${r.calendar_id}:${r.google_event_id}`,
      accountId: r.account_id,
      role: r.role,
      calendarId: r.calendar_id,
      googleEventId: r.google_event_id,
      title: r.title,
      start: iso(r.start_utc),
      end: iso(r.end_utc),
      allDay: !!r.all_day,
      isBusy: !!r.is_busy,
      startDate: r.start_date ?? undefined,
      endDate: r.end_date ?? undefined,
      etag: r.etag ?? undefined,
    }));
  }
  private meta() {
    const versions = this.versions();
    return {
      asOf: iso(this.at()),
      timezone: TIMEZONE,
      ownerRevision: versions.owner,
      versions,
      warnings: [] as unknown[],
    };
  }
  replayReceipt(
    tool: string,
    args: Record<string, unknown>,
    actor: Actor,
  ): unknown | undefined {
    this.scope(actor, "organizer:read");
    if (MUTATIONS[tool]) this.scope(actor, MUTATIONS[tool]);
    if (READ_SCOPES[tool]) this.scope(actor, READ_SCOPES[tool]);
    if (args.mode === "preview" || typeof args.idempotencyKey !== "string")
      return;
    const old = this.one(
      "SELECT * FROM command_receipts WHERE actor_id=? AND tool=? AND idempotency_key=?",
      actor.id,
      tool,
      args.idempotencyKey,
    );
    if (!old) return;
    if (tool === "retry_operation") {
      const op = this.one(
        "SELECT required_scope FROM outbox_operations WHERE id=?",
        String(args.operationId),
      );
      if (op) this.scope(actor, op.required_scope);
    }
    const fingerprint = canonical(
      Object.fromEntries(
        Object.entries(args).filter(([key]) => !key.startsWith("_")),
      ),
    );
    if (old.fingerprint !== fingerprint)
      this.fail(
        "IDEMPOTENCY_KEY_REUSED",
        "This key was used for different arguments.",
      );
    const result = parse(old.response_json, {});
    result.data.deduplicated = true;
    return result;
  }
  execute(tool: string, args: Record<string, unknown>, actor: Actor): unknown {
    this.scope(actor, "organizer:read");
    if (!Object.hasOwn(MUTATIONS, tool)) {
      if (READ_SCOPES[tool]) this.scope(actor, READ_SCOPES[tool]);
      return { data: this.query(tool, args as Row, actor), meta: this.meta() };
    }
    if (MUTATIONS[tool]) this.scope(actor, MUTATIONS[tool]);
    const a = args as Row;
    const preview = a.mode === "preview";
    if (a.mode !== undefined && !["preview", "apply"].includes(a.mode))
      this.fail("VALIDATION_ERROR", "Unknown command mode.");
    if (!preview) this.text(a.idempotencyKey, "idempotencyKey", 200);
    const fingerprint = canonical(
      Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith("_"))),
    );
    try {
      return this.db.transaction(() => {
        if (!preview) {
          const old = this.one(
            "SELECT * FROM command_receipts WHERE actor_id=? AND tool=? AND idempotency_key=?",
            actor.id,
            tool,
            a.idempotencyKey,
          );
          if (old) {
            if (old.fingerprint !== fingerprint)
              this.fail(
                "IDEMPOTENCY_KEY_REUSED",
                "This key was used for different arguments.",
              );
            const result = parse(old.response_json, {});
            result.data.deduplicated = true;
            return result;
          }
        }
        this.ctx = {
          actor,
          tool,
          args: a,
          at: this.now(),
          commandId: uid("cmd"),
          before: this.versions(),
          required: {},
          touched: new Set(),
          operations: [],
          entities: [],
          preview,
        };
        try {
          const data = this.mutate(tool, a);
          if (preview)
            throw new Preview({
              data: {
                ...data,
                outcome: "preview",
                requiredVersions: { ...this.ctx.required },
                effects: { ...data.effects, operationIds: [] },
                entities: [],
                syncStatus: "not_required",
              },
              meta: this.meta(),
            });
          this.bumpAggregate("owner");
          const effects = {
            ...data.effects,
            operationIds: [...this.ctx.operations],
          };
          const result = {
            data: {
              outcome: "applied",
              summary: data.summary ?? "Saved.",
              ...data,
              entities: this.ctx.entities.map((id) => ({ id })),
              effects,
              versions: this.versions(),
              syncStatus: this.ctx.operations.length
                ? "pending"
                : "not_required",
            },
            meta: this.meta(),
          };
          this.db.run(
            "INSERT INTO audit_log(id,command_id,actor_id,actor_type,action,entity_ids_json,summary,occurred_at) VALUES(?,?,?,?,?,?,?,?)",
            uid("chg"),
            this.ctx.commandId,
            actor.id,
            actor.type,
            tool,
            JSON.stringify(this.ctx.entities),
            result.data.summary,
            this.at(),
          );
          this.db.run(
            "INSERT INTO command_receipts(id,actor_id,tool,idempotency_key,fingerprint,response_json,committed_at) VALUES(?,?,?,?,?,?,?)",
            this.ctx.commandId,
            actor.id,
            tool,
            a.idempotencyKey,
            fingerprint,
            JSON.stringify(result),
            this.at(),
          );
          return result;
        } finally {
          this.ctx = undefined;
        }
      });
    } catch (error) {
      if (error instanceof Preview) return error.result;
      throw error;
    }
  }
  private page<T>(
    rows: T[],
    a: Row,
    actor: Actor,
    filter: Row,
  ): { items: T[]; nextCursor: string | null } {
    const limit =
      a.limit === undefined ? 25 : this.integer(a.limit, "limit", 1, 100);
    const fp = canonical(filter);
    const rev = this.versions().owner;
    let offset = 0;
    if (a.cursor) {
      const c = this.one("SELECT * FROM cursors WHERE id=?", String(a.cursor));
      if (
        !c ||
        c.actor_id !== actor.id ||
        c.fingerprint !== fp ||
        c.owner_revision !== rev ||
        c.expires_at < this.at()
      )
        this.fail("CURSOR_EXPIRED", "Read the first page again.");
      offset = c.offset_value;
    }
    let nextCursor: string | null = null;
    if (offset + limit < rows.length) {
      nextCursor = uid("cur");
      this.db.run(
        "INSERT INTO cursors(id,actor_id,fingerprint,owner_revision,offset_value,expires_at) VALUES(?,?,?,?,?,?)",
        nextCursor,
        actor.id,
        fp,
        rev,
        offset + limit,
        this.at() + 300000,
      );
    }
    return { items: rows.slice(offset, offset + limit), nextCursor };
  }
  private todayTickets(date: string, s = this.snapshot()): Ticket[] {
    const [start, end] = dayBounds(date);
    const active = new Set(
      s.items
        .filter((i) => i.kind === "project" && i.state === "active")
        .map((i) => i.id),
    );
    return s.tickets.filter(
      (t) =>
        active.has(t.projectId) &&
        t.status !== "closed" &&
        (t.plannedFor === date ||
          t.status === "in_progress" ||
          (t.doneAt &&
            Date.parse(t.doneAt) >= start &&
            Date.parse(t.doneAt) < end) ||
          s.bookings.some(
            (b) =>
              b.ticketId === t.id &&
              b.desiredPresence === "present" &&
              Date.parse(b.start) < end &&
              Date.parse(b.end) > start,
          )),
    );
  }
  private skipped(date: string): boolean {
    const previous = addDays(date, -1);
    const created = this.one(
      "SELECT created_at FROM settings WHERE id=1",
    )!.created_at;
    return (
      localParts(this.at()).hour >= 4 &&
      date === localParts(this.at()).date &&
      previous >= localParts(created).date &&
      !this.one(
        "SELECT id FROM reviews WHERE review_date=? AND saved_at IS NOT NULL",
        previous,
      ) &&
      !this.one(
        "SELECT local_date FROM daily_dismissals WHERE local_date=?",
        date,
      )
    );
  }
  private query(tool: string, a: Row, actor: Actor): unknown {
    const s = this.snapshot();
    switch (tool) {
      case "get_context":
        return {
          contractVersion: "1",
          timezone: TIMEZONE,
          localDate: s.localDate,
          reviewDate: s.reviewDate,
          reviewCutoff: iso(localInstant(addDays(s.reviewDate, 1), 240)),
          areas: AREAS,
          grantedScopes: actor.scopes,
          rules: {
            placesPerArea: { project: 1, book: 1 },
            savedReviewsFinal: true,
          },
          limits: { maxPageSize: 100, calendarDays: 31 },
          connections: s.connections,
        };
      case "get_today": {
        const date = this.date(a.date ?? s.localDate),
          tickets = this.todayTickets(date, s);
        return {
          date,
          tickets,
          todayTickets: tickets,
          openPlaces: 8 - s.items.filter((i) => i.state === "active").length,
          skippedReviewNote: this.skipped(date),
          events: this.authorizedEvents(actor, a.detail).filter((e) =>
            e.allDay
              ? e.startDate! <= date && e.endDate! > date
              : Date.parse(e.start!) < dayBounds(date)[1] &&
                Date.parse(e.end!) > dayBounds(date)[0],
          ),
          bookings: s.bookings.filter((b) => {
            const [st, en] = dayBounds(date);
            return Date.parse(b.start) < en && Date.parse(b.end) > st;
          }),
          href: "/#/today",
        };
      }
      case "get_board":
        return {
          areas: AREAS.map((ar) => ({
            ...ar,
            places: {
              project:
                s.items.find(
                  (i) =>
                    i.areaId === ar.id &&
                    i.kind === "project" &&
                    i.state === "active",
                ) ?? null,
              book:
                s.items.find(
                  (i) =>
                    i.areaId === ar.id &&
                    i.kind === "book" &&
                    i.state === "active",
                ) ?? null,
            },
            upNext: s.items
              .filter((i) => i.areaId === ar.id && i.state === "queued")
              .sort(
                (x, y) =>
                  (x.order ?? 0) - (y.order ?? 0) || x.id.localeCompare(y.id),
              ),
          })),
          href: "/#/board",
        };
      case "list_items": {
        if (a.areaId) this.area(a.areaId);
        const q = String(a.query ?? "").toLocaleLowerCase();
        const rows = s.items
          .filter(
            (i) =>
              (!a.kind || i.kind === a.kind) &&
              (!a.areaId || i.areaId === a.areaId) &&
              (!a.states || a.states.includes(i.state)) &&
              (!q || i.title.toLocaleLowerCase().includes(q)),
          )
          .sort(
            (x, y) =>
              x.createdAt.localeCompare(y.createdAt) ||
              x.id.localeCompare(y.id),
          );
        return this.page(rows, a, actor, {
          tool,
          kind: a.kind,
          areaId: a.areaId,
          states: a.states,
          query: q,
        });
      }
      case "get_item": {
        const item = this.item(a.itemId);
        return {
          item,
          learnings: this.page(
            s.learnings.filter(
              (l) => l.projectId === item.id || l.bookId === item.id,
            ),
            a,
            actor,
            { tool, itemId: item.id },
          ),
          permittedActions: this.actions(item),
          href:
            item.kind === "project"
              ? `/#/project/${item.id}`
              : `/#/bookshelf/${item.id}`,
        };
      }
      case "list_tickets": {
        if (!a.projectId && !a.date)
          this.fail("VALIDATION_ERROR", "A projectId or date is required.");
        if (a.projectId) this.item(a.projectId);
        const day = a.date
          ? new Set(this.todayTickets(this.date(a.date), s).map((t) => t.id))
          : undefined;
        const rows = s.tickets.filter(
          (t) =>
            (!a.projectId || t.projectId === a.projectId) &&
            (!day || day.has(t.id)) &&
            (!a.statuses || a.statuses.includes(t.status)) &&
            (a.booked === undefined || !!t.currentBookingId === a.booked),
        );
        return this.page(rows, a, actor, {
          tool,
          projectId: a.projectId,
          date: a.date,
          statuses: a.statuses,
          booked: a.booked,
        });
      }
      case "get_ticket": {
        const ticket = this.ticket(a.ticketId);
        const project = this.item(ticket.projectId);
        return {
          ticket,
          project,
          currentBooking: ticket.currentBookingId
            ? this.booking(ticket.currentBookingId)
            : null,
          permittedActions:
            project.state === "active"
              ? [
                  "update_ticket",
                  "set_ticket_status",
                  "set_ticket_day",
                  "book_ticket",
                ]
              : terminal.has(project.state)
                ? []
                : ["update_ticket"],
          href: `/#/project/${project.id}`,
        };
      }
      case "list_calendar_events": {
        const start = this.instant(a.start),
          end = this.instant(a.end);
        this.intervalWindow(start, end);
        if (a.detail === "titles") this.scope(actor, "calendar:details:read");
        const rows = this.authorizedEvents(actor, a.detail, {
          start,
          end,
        }).filter(
          (e: any) =>
            (!a.roles || a.roles.includes(e.role)) &&
            (e.allDay
              ? e.startDate <= localParts(end - 1).date &&
                e.endDate > localParts(start).date
              : Date.parse(e.start) < end && Date.parse(e.end) > start),
        );
        return {
          ...this.page(rows, a, actor, {
            tool,
            start: a.start,
            end: a.end,
            roles: a.roles,
            detail: a.detail,
          }),
          freshness: s.connections,
        };
      }
      case "find_free_starts": {
        const date = this.date(a.date);
        const length =
          a.lengthMinutes === undefined
            ? 60
            : this.integer(a.lengthMinutes, "lengthMinutes", 15, 960);
        if (length % 15)
          this.fail(
            "VALIDATION_ERROR",
            "lengthMinutes must use 15-minute steps.",
          );
        return {
          date,
          starts: this.freeStarts(
            date,
            length,
            a.from ? this.instant(a.from) : undefined,
            a.excludeBookingId,
          ),
          freshness: s.connections,
          complete: this.availabilityComplete(),
        };
      }
      case "list_bookings": {
        if (!a.ticketId && (!a.start || !a.end))
          this.fail("VALIDATION_ERROR", "ticketId or start/end is required.");
        let rows = s.bookings;
        if (a.ticketId) {
          this.ticket(a.ticketId);
          rows = rows.filter((b) => b.ticketId === a.ticketId);
        } else {
          const st = this.instant(a.start),
            en = this.instant(a.end);
          this.intervalWindow(st, en);
          rows = rows.filter(
            (b) => Date.parse(b.start) < en && Date.parse(b.end) > st,
          );
        }
        return this.page(rows, a, actor, {
          tool,
          ticketId: a.ticketId,
          start: a.start,
          end: a.end,
        });
      }
      case "get_review":
        return this.reviewContext(this.date(a.date ?? s.reviewDate));
      case "get_connections":
        return { connections: s.connections };
      case "get_calendar_sync":
        return {
          connections: s.connections.filter(
            (c) => !a.role || c.role === a.role,
          ),
          operations: s.operations.filter((o) => {
            const r = this.one(
              "SELECT account_id FROM outbox_operations WHERE id=?",
              o.id,
            )!;
            return (
              !a.role ||
              s.connections.find((c) => c.id === r.account_id)?.role === a.role
            );
          }),
        };
      case "get_calendar_connect_link": {
        if (!["personal", "work"].includes(a.role))
          this.fail("VALIDATION_ERROR", "Unknown calendar role.");
        return { role: a.role, href: `/auth/calendar?role=${a.role}` };
      }
      case "get_operation": {
        const r = this.one(
          "SELECT * FROM outbox_operations WHERE id=?",
          String(a.operationId),
        );
        if (!r) this.fail("NOT_FOUND", "Operation not found.");
        return this.mapOperation(r);
      }
      case "list_changes": {
        let rows = this.db.all(
          "SELECT * FROM audit_log ORDER BY occurred_at DESC,id",
        );
        if (a.since) {
          const at = this.instant(a.since);
          rows = rows.filter((r) => r.occurred_at >= at);
        }
        if (a.until) {
          const at = this.instant(a.until);
          rows = rows.filter((r) => r.occurred_at < at);
        }
        if (a.entityId)
          rows = rows.filter((r) =>
            parse(r.entity_ids_json, []).includes(a.entityId),
          );
        return this.page(
          rows.map((r) => ({
            id: r.id,
            commandId: r.command_id,
            actorId: r.actor_id,
            actorType: r.actor_type,
            action: r.action,
            entityIds: parse(r.entity_ids_json, []),
            summary: r.summary,
            occurredAt: iso(r.occurred_at),
          })),
          a,
          actor,
          { tool, since: a.since, until: a.until, entityId: a.entityId },
        );
      }
      case "search_books":
      case "get_book_candidate":
        return this.fail(
          "INTEGRATION_REQUIRED",
          "Book discovery is handled by the Open Library adapter.",
        );
      default:
        return this.fail("NOT_FOUND", "Unknown Organizer workflow.");
    }
  }
  private actions(item: Item) {
    if (item.state === "queued") return ["update_" + item.kind, "start_item"];
    if (item.state === "active")
      return [
        "update_" + item.kind,
        "pause_item",
        "finish_item",
        "archive_item",
      ];
    if (item.state === "paused") return ["update_" + item.kind, "resume_item"];
    if (item.state === "archived") return ["restore_item"];
    return [];
  }
  private authorizedEvents(
    actor: Actor,
    detail?: string,
    window?: { start: number; end: number },
  ) {
    if (!this.can(actor, "calendar:busy:read")) return [];
    const titles =
      detail === "titles" && this.can(actor, "calendar:details:read");
    return this.eventProjection(window).map((e) => ({
      ...e,
      title: titles ? e.title : "Busy",
    }));
  }
  private intervalWindow(start: number, end: number) {
    if (end <= start || end - start > 31 * 86400000)
      this.fail(
        "VALIDATION_ERROR",
        "Calendar windows must be positive and at most 31 days.",
      );
  }
  private availabilityComplete() {
    return this.db
      .all("SELECT * FROM calendar_accounts")
      .every(
        (a) =>
          a.status === "connected" &&
          a.last_synced_at != null &&
          a.last_synced_at >= this.at() - CALENDAR_SYNC_INTERVAL_MS,
      );
  }
  private busy(
    date: string,
    exclude?: string,
  ): { start: number; end: number; id: string }[] {
    const [start, end] = dayBounds(date);
    const excluded = exclude
      ? this.one("SELECT * FROM bookings WHERE id=?", exclude)
      : undefined;
    const out: { start: number; end: number; id: string }[] = [];
    for (const e of this.eventProjection({ start, end })) {
      if (e.allDay || !e.isBusy || !e.start || !e.end) continue;
      if (
        excluded &&
        e.accountId === excluded.account_id &&
        e.calendarId === excluded.calendar_id &&
        e.googleEventId === excluded.google_event_id
      )
        continue;
      const st = Date.parse(e.start),
        en = Date.parse(e.end);
      if (st < end && en > start) out.push({ start: st, end: en, id: e.id });
    }
    for (const b of this.db.all(
      "SELECT * FROM bookings WHERE id<>? AND provider_deleted_at IS NULL",
      exclude ?? "",
    )) {
      if (
        b.desired_presence === "present" &&
        b.start_utc < end &&
        b.end_utc > start
      )
        out.push({ start: b.start_utc, end: b.end_utc, id: b.id });
      if (
        b.remote_start_utc != null &&
        b.remote_start_utc < end &&
        b.remote_end_utc > start
      )
        out.push({
          start: b.remote_start_utc,
          end: b.remote_end_utc,
          id: b.id,
        });
    }
    return out.sort((x, y) => x.start - y.start || x.end - y.end);
  }
  private freeStarts(
    date: string,
    length: number,
    from?: number,
    exclude?: string,
    additional: { start: number; end: number }[] = [],
  ): string[] {
    let cur =
      Math.ceil(
        Math.max(
          localInstant(date, 420),
          from ??
            (date === localParts(this.at()).date
              ? this.at() + 900000
              : localInstant(date, 420)),
        ) / 900000,
      ) * 900000;
    const latest = localInstant(date, 1320);
    const end = localInstant(date, 1380);
    const results: string[] = [];
    const intervals = [...this.busy(date, exclude), ...additional].sort(
      (x, y) => x.start - y.start,
    );
    for (const e of [...intervals, { start: end, end }]) {
      if (cur < latest && e.start - cur >= length * 60000) {
        results.push(iso(cur)!);
        if (results.length === 4) break;
      }
      cur = Math.max(cur, Math.ceil(e.end / 900000) * 900000);
      if (cur >= latest) break;
    }
    return results;
  }
  private checkBooking(
    start: number,
    end: number,
    allowOverlap: boolean,
    acceptIncomplete: boolean,
    exclude?: string,
    allowOngoingStart = false,
  ) {
    const p = localParts(start),
      q = localParts(end);
    if (
      p.date !== q.date ||
      p.hour * 60 + p.minute < 420 ||
      q.hour * 60 + q.minute > 1380 ||
      end - start < 900000 ||
      start % 900000 ||
      end % 900000 ||
      end <= start
    )
      this.fail(
        "VALIDATION_ERROR",
        "Book within one local day, 07:00–23:00, in 15-minute steps.",
      );
    if (start < this.at() && !(allowOngoingStart && end > this.at()))
      this.fail("VALIDATION_ERROR", "A new booking cannot start in the past.");
    if (!acceptIncomplete && !this.availabilityComplete())
      this.fail(
        "AVAILABILITY_INCOMPLETE",
        "Calendar busy data is stale or disconnected; refresh or explicitly accept incomplete availability.",
      );
    const conflicts = this.busy(p.date, exclude).filter(
      (e) => e.start < end && e.end > start,
    );
    if (conflicts.length && !allowOverlap)
      this.fail("BOOKING_CONFLICT", "That interval overlaps busy time.", {
        relatedIds: conflicts.map((e) => e.id),
      });
    return conflicts;
  }
  private appendQueue(item: Item) {
    const position =
      (this.one(
        "SELECT MAX(position) AS n FROM queue_entries WHERE area_id=?",
        item.areaId,
      )?.n ?? -1) + 1;
    this.db.run(
      "INSERT INTO queue_entries(id,area_id,position,project_id,book_id) VALUES(?,?,?,?,?)",
      uid("que"),
      item.areaId,
      position,
      item.kind === "project" ? item.id : null,
      item.kind === "book" ? item.id : null,
    );
    this.bumpAggregate(`queue:${item.areaId}`);
  }
  private seedColumns(id: string) {
    for (const status of ["todo", "in_progress", "done", "closed"])
      this.db.run(
        "INSERT INTO aggregate_versions(key,version) VALUES(?,1)",
        `tickets:${id}:${status}`,
      );
  }
  private newTicket(projectId: string, title: string): Ticket {
    const id = uid("tkt");
    const order =
      (this.one(
        "SELECT MAX(column_position) AS n FROM tickets WHERE project_id=? AND status='todo'",
        projectId,
      )?.n ?? -1) + 1;
    this.db.run(
      "INSERT INTO tickets(id,project_id,title,column_position,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      id,
      projectId,
      this.text(title, "title", 500),
      order,
      this.at(),
      this.at(),
    );
    this.touch("tickets", id, `ticket:${id}`);
    this.bumpAggregate(`tickets:${projectId}:todo`);
    return this.ticket(id);
  }
  private queueProject(a: Row) {
    const area = this.area(a.areaId);
    this.need(`queue:${area}`);
    const title = this.text(a.title, "title");
    const goal = a.goal == null ? null : this.text(a.goal, "goal", 2000);
    const titles = a.initialTicketTitles ?? [];
    if (!Array.isArray(titles) || titles.length > 50)
      this.fail(
        "VALIDATION_ERROR",
        "At most 50 initial ticket titles are allowed.",
      );
    const id = uid("prj");
    this.db.run(
      "INSERT INTO projects(id,area_id,title,goal,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
      id,
      area,
      title,
      goal,
      this.at(),
      this.at(),
    );
    this.itemTouch(this.item(id));
    this.seedColumns(id);
    this.appendQueue(this.item(id));
    for (const t of titles) this.newTicket(id, t);
    return { item: this.item(id), summary: "Project added to Up next." };
  }
  private authors(v: unknown): string[] {
    if (
      !Array.isArray(v) ||
      v.length > 20 ||
      v.some(
        (x) => typeof x !== "string" || x.trim().length < 1 || x.length > 200,
      )
    )
      this.fail(
        "VALIDATION_ERROR",
        "authors must be an array of at most 20 names.",
      );
    return v.map((x) => x.trim());
  }
  private isbn(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).replace(/[ -]/g, "").toUpperCase();
    if (!/^(?:\d{13}|\d{9}[\dX])$/.test(s))
      this.fail("VALIDATION_ERROR", "A valid ISBN-10 or ISBN-13 is required.");
    const digits = [...s].map((c) => (c === "X" ? 10 : Number(c)));
    const valid =
      s.length === 10
        ? digits.reduce((sum, n, i) => sum + n * (10 - i), 0) % 11 === 0
        : digits.reduce((sum, n, i) => sum + n * (i % 2 ? 3 : 1), 0) % 10 === 0;
    if (!valid) this.fail("VALIDATION_ERROR", "ISBN checksum is invalid.");
    return s;
  }
  private queueBook(a: Row) {
    const area = this.area(a.areaId);
    this.need(`queue:${area}`);
    const source = a.source;
    if (!source || !["manual", "open_library"].includes(source.type))
      this.fail(
        "VALIDATION_ERROR",
        "A manual or Open Library source is required.",
      );
    const b = source.type === "manual" ? source : a._resolvedBook;
    if (!b)
      this.fail(
        "BOOK_METADATA_INCOMPLETE",
        "Resolve the selected edition before adding it.",
      );
    const title = this.text(b.title, "title");
    const authors = this.authors(b.authors ?? []);
    const unit = source.progressUnit ?? "pages";
    if (unit !== "pages" && unit !== "time")
      this.fail("VALIDATION_ERROR", "progressUnit must be pages or time.", {
        field: "progressUnit",
      });
    if (unit === "time" && source.type !== "manual")
      this.fail(
        "VALIDATION_ERROR",
        "Audiobooks are added by hand with a length in hours and minutes.",
        { field: "progressUnit" },
      );
    const audiobook = unit === "time";
    if (audiobook && (a.pageCountOverride != null || source.pageCount != null))
      this.fail("VALIDATION_ERROR", "Audiobooks do not take a page count.", {
        field: "pageCount",
      });
    if (!audiobook && source.duration != null)
      this.fail("VALIDATION_ERROR", "Page books do not take a duration.", {
        field: "duration",
      });
    const duration = audiobook
      ? this.clock(source.duration, "duration", 1)
      : null;
    const count = audiobook ? null : (a.pageCountOverride ?? b.pageCount);
    if (!audiobook && count == null)
      this.fail(
        "BOOK_METADATA_INCOMPLETE",
        "A positive page count is required.",
      );
    const pages = audiobook
      ? null
      : this.integer(count, "pageCount", 1, 100000);
    const work = source.type === "manual" ? null : (b.workId ?? null),
      edition = source.type === "manual" ? null : (b.editionId ?? null),
      isbn = this.isbn(source.type === "manual" ? null : b.isbn);
    if (
      (work && !/^\/works\/OL\d+W$/.test(work)) ||
      (edition && !/^(?:\/books\/)?OL\d+M$/.test(edition))
    )
      this.fail("VALIDATION_ERROR", "Invalid Open Library identifier.");
    const dup = this.one(
      "SELECT id FROM books WHERE (? IS NOT NULL AND work_id=?) OR (? IS NOT NULL AND edition_id=?) OR (? IS NOT NULL AND isbn=?)",
      work,
      work,
      edition,
      edition,
      isbn,
      isbn,
    );
    if (dup)
      this.fail("BOOK_ALREADY_QUEUED", "This book is already tracked.", {
        itemId: dup.id,
        href: `/#/bookshelf/${dup.id}`,
      });
    const id = uid("book");
    const provenance = audiobook
      ? "manual"
      : a.pageCountOverride !== undefined || source.type === "manual"
        ? "manual"
        : (b.pageCountSource ?? "edition");
    if (!["manual", "edition", "work_median"].includes(provenance))
      this.fail("VALIDATION_ERROR", "Unknown page count source.");
    let cover: string | null = null;
    if (b.coverUrl && source.type !== "manual") {
      try {
        const url = new URL(b.coverUrl);
        if (
          url.protocol !== "https:" ||
          url.hostname !== "covers.openlibrary.org"
        )
          throw new Error();
        cover = url.href;
      } catch {
        this.fail(
          "VALIDATION_ERROR",
          "Only provider-resolved Open Library covers are permitted.",
        );
      }
    }
    this.db.run(
      audiobook
        ? "INSERT INTO books(id,area_id,title,authors_json,work_id,edition_id,isbn,cover_url,cover_id,page_count,page_count_source,progress_unit,duration_minutes,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,?,?,'queued',?,?)"
        : "INSERT INTO books(id,area_id,title,authors_json,work_id,edition_id,isbn,cover_url,cover_id,page_count,page_count_source,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)",
      id,
      area,
      title,
      JSON.stringify(authors),
      work,
      edition,
      isbn,
      cover,
      b.coverId == null ? null : String(b.coverId),
      ...(audiobook
        ? [provenance, "time", duration, this.at(), this.at()]
        : [pages, provenance, this.at(), this.at()]),
    );
    this.itemTouch(this.item(id));
    this.appendQueue(this.item(id));
    return { item: this.item(id), summary: "Book added to Up next." };
  }
  private holder(item: Item) {
    return this.one(
      `SELECT id FROM ${item.kind === "project" ? "projects" : "books"} WHERE area_id=? AND state='active'`,
      item.areaId,
    );
  }
  private start(item: Item, resume = false) {
    this.need(`item:${item.id}`);
    this.need(`place:${item.areaId}:${item.kind}`);
    if (item.state !== (resume ? "paused" : "queued"))
      this.fail(
        "INVALID_TRANSITION",
        resume
          ? "Only paused items can resume."
          : "Only queued items can start.",
      );
    const current = this.holder(item);
    if (current)
      this.fail("PLACE_RESERVED", "This place is already reserved.", {
        currentItemId: current.id,
      });
    if (!resume) {
      this.need(`queue:${item.areaId}`);
      this.db.run(
        `DELETE FROM queue_entries WHERE ${item.kind === "project" ? "project_id" : "book_id"}=?`,
        item.id,
      );
      this.bumpAggregate(`queue:${item.areaId}`);
    }
    this.db.run(
      `UPDATE ${item.kind === "project" ? "projects" : "books"} SET state='active',started_at=COALESCE(started_at,?) WHERE id=?`,
      this.at(),
      item.id,
    );
    this.itemTouch(item);
    this.bumpAggregate(`place:${item.areaId}:${item.kind}`);
  }
  private vacate(item: Item, state: "paused" | "archived" | "done") {
    this.need(`item:${item.id}`);
    this.need(`place:${item.areaId}:${item.kind}`);
    if (item.state !== "active")
      this.fail(
        "INVALID_TRANSITION",
        "Only an active item can pause, archive, or finish.",
      );
    const table = item.kind === "project" ? "projects" : "books";
    const timeField =
      state === "paused"
        ? "paused_at"
        : state === "archived"
          ? "archived_at"
          : "done_at";
    this.db.run(
      `UPDATE ${table} SET state=?,${timeField}=?${
        item.kind === "book" && state === "done"
          ? ",current_page=CASE WHEN progress_unit='pages' THEN page_count ELSE current_page END,position_minutes=CASE WHEN progress_unit='time' THEN duration_minutes ELSE position_minutes END"
          : ""
      } WHERE id=?`,
      state,
      this.at(),
      item.id,
    );
    this.itemTouch(item);
    this.bumpAggregate(`place:${item.areaId}:${item.kind}`);
    if (item.kind === "project")
      for (const r of this.db.all(
        "SELECT * FROM tickets WHERE project_id=?",
        item.id,
      )) {
        const t = this.mapTicket(r);
        this.need(`ticket:${t.id}`);
        let status = t.status;
        if (state === "paused" && status === "in_progress") status = "todo";
        if (state === "done" && (status === "todo" || status === "in_progress"))
          status = "closed";
        this.db.run(
          "UPDATE tickets SET status=?,planned_for=CASE WHEN status IN ('todo','in_progress') THEN NULL ELSE planned_for END,current_booking_id=NULL WHERE id=?",
          status,
          t.id,
        );
        this.touch("tickets", t.id, `ticket:${t.id}`);
        if (status !== t.status) {
          this.bumpAggregate(`tickets:${item.id}:${t.status}`);
          this.bumpAggregate(`tickets:${item.id}:${status}`);
        }
        for (const row of this.db.all(
          "SELECT * FROM bookings WHERE ticket_id=? AND desired_presence='present' AND provider_deleted_at IS NULL AND start_utc>=?",
          t.id,
          this.at(),
        )) {
          const b = this.mapBooking(row);
          this.need(`booking:${b.id}`);
          this.cancelBooking(b, false);
        }
        if (t.currentBookingId) {
          const b = this.booking(t.currentBookingId);
          if (Date.parse(b.start) < this.at()) {
            this.need(`booking:${b.id}`);
            this.db.run(
              "UPDATE bookings SET retired_at=? WHERE id=?",
              this.at(),
              b.id,
            );
            this.touch("bookings", b.id, `booking:${b.id}`);
          }
        }
      }
  }
  private putStatus(t: Ticket, status: string, beforeId?: string | null) {
    const item = this.item(t.projectId);
    this.active(item);
    if (
      !["todo", "in_progress", "done"].includes(status) ||
      t.status === "closed"
    )
      this.fail(
        "TICKET_NOT_ACTIONABLE",
        "This ticket cannot accept that status.",
      );
    this.need(`ticket:${t.id}`);
    this.need(`item:${item.id}`);
    this.need(`tickets:${item.id}:${t.status}`);
    this.need(`tickets:${item.id}:${status}`);
    this.db.run(
      "UPDATE tickets SET status=?,done_at=? WHERE id=?",
      status,
      status === "done" ? this.at() : null,
      t.id,
    );
    this.touch("tickets", t.id, `ticket:${t.id}`);
    this.itemTouch(item);
    this.bumpAggregate(`tickets:${item.id}:${t.status}`);
    this.bumpAggregate(`tickets:${item.id}:${status}`);
    this.orderTickets(item.id, status, t.id, beforeId ?? null);
  }
  private orderTickets(
    projectId: string,
    status: string,
    id: string,
    beforeId: string | null,
  ) {
    const ids = this.db
      .all(
        "SELECT id FROM tickets WHERE project_id=? AND status=? ORDER BY column_position,id",
        projectId,
        status,
      )
      .map((r) => r.id)
      .filter((x) => x !== id);
    if (beforeId !== null && !ids.includes(beforeId))
      this.fail(
        "VALIDATION_ERROR",
        "The destination ticket must be in the same project column.",
      );
    ids.splice(beforeId === null ? ids.length : ids.indexOf(beforeId), 0, id);
    for (const [i, x] of ids.entries()) {
      this.db.run("UPDATE tickets SET column_position=? WHERE id=?", i, x);
      this.touch("tickets", x, `ticket:${x}`);
    }
    this.bumpAggregate(`tickets:${projectId}:${status}`);
  }
  private personal(): Row {
    const p = this.one("SELECT * FROM calendar_accounts WHERE role='personal'");
    if (!p || p.status !== "connected" || !p.encrypted_credentials)
      this.fail(
        "RECONNECT_REQUIRED",
        "Connect the Personal calendar before booking time.",
      );
    return p;
  }
  private enqueue(
    action: string,
    booking: Booking | null,
    accountId: string,
    payload: Row,
    scope?: string,
  ): string {
    const id = uid("op");
    this.db.run(
      "INSERT INTO outbox_operations(id,command_id,actor_id,required_scope,booking_id,account_id,action,payload_json,target_booking_version,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      id,
      this.ctx?.commandId ?? null,
      this.ctx?.actor.id ?? "system",
      scope ?? MUTATIONS[this.ctx?.tool ?? ""] ?? "calendar:book",
      booking?.id ?? null,
      accountId,
      action,
      JSON.stringify(payload),
      booking ? Number(booking.version) : null,
      this.at(),
      this.at(),
      this.at(),
    );
    this.ctx?.operations.push(id);
    return id;
  }
  private supersede(bookingId: string, preserveCreate = false) {
    this.db.run(
      `UPDATE outbox_operations SET state='superseded',version=version+1,updated_at=? WHERE booking_id=? AND state IN ('pending','waiting_retry','needs_reconnect','failed')${preserveCreate ? " AND action<>'create'" : ""}`,
      this.at(),
      bookingId,
    );
  }
  private createBooking(
    t: Ticket,
    start: number,
    end: number,
    allowOverlap: boolean,
    acceptIncomplete: boolean,
  ) {
    const item = this.item(t.projectId);
    this.active(item);
    if (t.status === "done" || t.status === "closed")
      this.fail(
        "TICKET_NOT_ACTIONABLE",
        "Completed tickets cannot acquire bookings.",
      );
    this.need(`ticket:${t.id}`);
    this.need(`item:${item.id}`);
    if (t.currentBookingId) {
      const old = this.booking(t.currentBookingId);
      this.need(`booking:${old.id}`);
      if (old.desiredPresence === "present" && Date.parse(old.end) > this.at())
        this.fail(
          "BOOKING_EXISTS",
          "Move or remove the current booking first.",
          { bookingId: old.id },
        );
      this.db.run(
        "UPDATE bookings SET retired_at=? WHERE id=?",
        this.at(),
        old.id,
      );
      this.touch("bookings", old.id, `booking:${old.id}`);
    }
    const personal = this.personal();
    this.checkBooking(start, end, allowOverlap, acceptIncomplete);
    const id = uid("booked"),
      google = crypto.randomUUID().replaceAll("-", "");
    this.db.run(
      "INSERT INTO bookings(id,ticket_id,account_id,calendar_id,google_event_id,start_utc,end_utc,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      t.id,
      personal.id,
      personal.write_calendar_id ?? "primary",
      google,
      start,
      end,
      this.at(),
      this.at(),
    );
    this.db.run("UPDATE tickets SET current_booking_id=? WHERE id=?", id, t.id);
    this.touch("tickets", t.id, `ticket:${t.id}`);
    this.touch("bookings", id, `booking:${id}`);
    this.enqueue("create", this.booking(id), personal.id, {
      summary: t.title,
      projectTitle: item.title,
      start: iso(start),
      end: iso(end),
    });
    return this.booking(id);
  }
  private actionableBooking(b: Booking) {
    const t = this.ticket(b.ticketId);
    const p = this.item(t.projectId);
    this.active(p);
    if (
      t.currentBookingId !== b.id ||
      b.retiredAt ||
      b.desiredPresence !== "present" ||
      Date.parse(b.end) <= this.at()
    )
      this.fail(
        "BOOKING_NOT_CURRENT",
        "Only the current upcoming/ongoing booking can be changed.",
      );
    this.need(`booking:${b.id}`);
    this.need(`ticket:${t.id}`);
    this.need(`item:${p.id}`);
    return t;
  }
  private moveBooking(
    b: Booking,
    start: number,
    end: number,
    allowOverlap: boolean,
    acceptIncomplete: boolean,
  ) {
    this.actionableBooking(b);
    this.personal();
    this.checkBooking(
      start,
      end,
      allowOverlap,
      acceptIncomplete,
      b.id,
      start === Date.parse(b.start),
    );
    const before = {
      start: b.remoteStart ?? b.start,
      end: b.remoteEnd ?? b.end,
    };
    this.db.run(
      "UPDATE bookings SET start_utc=?,end_utc=?,sync_state='pending' WHERE id=?",
      start,
      end,
      b.id,
    );
    this.touch("bookings", b.id, `booking:${b.id}`);
    this.supersede(b.id, true);
    this.enqueue("update", this.booking(b.id), b.accountId, {
      start: iso(start),
      end: iso(end),
      before,
    });
    return this.booking(b.id);
  }
  private cancelBooking(b: Booking, check = true) {
    if (check) this.actionableBooking(b);
    this.db.run(
      "UPDATE bookings SET desired_presence='absent',retired_at=?,sync_state='pending' WHERE id=?",
      this.at(),
      b.id,
    );
    this.db.run(
      "UPDATE tickets SET current_booking_id=NULL WHERE id=? AND current_booking_id=?",
      b.ticketId,
      b.id,
    );
    this.touch("tickets", b.ticketId, `ticket:${b.ticketId}`);
    this.touch("bookings", b.id, `booking:${b.id}`);
    this.supersede(b.id);
    this.enqueue("delete", this.booking(b.id), b.accountId, {});
  }
  private addLearning(
    text: unknown,
    target: Row,
    reviewId: string | null = null,
    date = localParts(this.at()).date,
  ) {
    if (!target || !["project", "book"].includes(target.kind))
      this.fail(
        "VALIDATION_ERROR",
        "Exactly one project or book target is required.",
      );
    const item = this.item(target.id);
    if (item.kind !== target.kind)
      this.fail(
        "VALIDATION_ERROR",
        "Learning target kind does not match its item.",
      );
    if (!reviewId) {
      this.active(item);
      this.need(`item:${item.id}`);
    }
    const id = uid("lrn");
    this.db.run(
      "INSERT INTO learnings(id,text,created_on,source_kind,review_id,project_id,book_id,created_by_actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      this.text(text, "text", 2000),
      date,
      reviewId ? "review" : "direct",
      reviewId,
      item.kind === "project" ? item.id : null,
      item.kind === "book" ? item.id : null,
      this.ctx!.actor.id,
      this.at(),
    );
    this.itemTouch(item);
    this.ctx!.entities.push(id);
    return {
      id,
      text: this.text(text, "text", 2000),
      createdOn: date,
      target,
      sourceKind: reviewId ? "review" : "direct",
    };
  }
  private reviewBaseline(date: string): Record<string, string> {
    const s = this.snapshot(),
      out: Record<string, string> = {};
    const ids = new Set(this.todayTickets(date, s).map((t) => t.id));
    for (const item of s.items.filter((i) => i.state === "active")) {
      out[`item:${item.id}`] = item.version;
      out[`place:${item.areaId}:${item.kind}`] =
        s.versions[`place:${item.areaId}:${item.kind}`];
      if (item.kind === "project")
        for (const status of ["todo", "in_progress", "done", "closed"])
          out[`tickets:${item.id}:${status}`] =
            s.versions[`tickets:${item.id}:${status}`];
    }
    for (const t of s.tickets.filter((t) => ids.has(t.id))) {
      out[`ticket:${t.id}`] = t.version;
      if (t.currentBookingId)
        out[`booking:${t.currentBookingId}`] =
          s.versions[`booking:${t.currentBookingId}`];
    }
    return out;
  }
  private defaultDraft(date: string): ReviewDraft {
    const s = this.snapshot(),
      tickets = this.todayTickets(date, s),
      tomorrow = addDays(date, 1),
      staged: { start: number; end: number }[] = [];
    const complete = tickets
      .filter((t) => t.status === "done")
      .map((t) => t.id);
    return {
      completedTicketIds: complete,
      slippedDestinations: tickets
        .filter((t) => !complete.includes(t.id))
        .map((t) => {
          const starts =
            this.availabilityComplete() &&
            s.connections.some(
              (c) => c.role === "personal" && c.status === "connected",
            )
              ? this.freeStarts(tomorrow, 60, undefined, undefined, staged)
              : [];
          if (starts.length) {
            const start = Date.parse(starts[0]),
              end = start + 3600000;
            staged.push({ start, end });
            return {
              ticketId: t.id,
              destination: {
                kind: "book" as const,
                start: iso(start)!,
                end: iso(end)!,
                allowOverlap: false,
              },
            };
          }
          return {
            ticketId: t.id,
            destination: { kind: "tomorrow_unbooked" as const },
          };
        }),
      bookPages: s.items
        .filter((i) => i.kind === "book" && i.state === "active")
        .map((b) =>
          b.progressUnit === "time"
            ? { bookId: b.id, positionMinutes: b.positionMinutes ?? 0 }
            : { bookId: b.id, currentPage: b.currentPage ?? 0 },
        ),
      markReadBookIds: [],
      learning: null,
    };
  }
  private reviewContext(date: string) {
    const r = this.one("SELECT * FROM reviews WHERE review_date=?", date),
      saved = r?.saved_at != null;
    return {
      date,
      eligible: date === reviewDate(this.at()),
      final: saved,
      review: r
        ? {
            id: r.id,
            date,
            version: String(r.version),
            draft: parse(r.draft_json, undefined),
            saved: parse(r.saved_json, undefined),
            savedAt: iso(r.saved_at),
          }
        : null,
      draft: saved ? undefined : parse(r?.draft_json, this.defaultDraft(date)),
      tickets: this.todayTickets(date),
      books: this.snapshot().items.filter(
        (i) => i.kind === "book" && i.state === "active",
      ),
      learningTargets: this.snapshot().items.filter(
        (i) => i.state === "active",
      ),
      requiredVersions: {
        ...this.reviewBaseline(date),
        [`review:${date}`]: String(r?.version ?? 0),
      },
      baselineVersions: parse(r?.baseline_json, {}),
      href: "/#/review",
    };
  }
  private ensureReviewDay(date: string) {
    if (
      this.one("SELECT saved_at FROM reviews WHERE review_date=?", date)
        ?.saved_at != null
    )
      this.fail("REVIEW_ALREADY_SAVED", "Saved reviews are final.");
    if (date !== reviewDate(this.at()))
      this.fail(
        "REVIEW_DAY_CLOSED",
        "Only the currently eligible unsaved review day can be changed.",
      );
    this.need(`review:${date}`);
  }
  private canonicalProgress(entry: Row, book: Item) {
    const hasPage = entry.currentPage !== undefined;
    const hasClock = entry.position !== undefined;
    const hasMinutes = entry.positionMinutes !== undefined;
    if (book.progressUnit === "time") {
      if (hasPage)
        this.fail(
          "VALIDATION_ERROR",
          "Audiobooks take a listening position in hours and minutes, not a page.",
          { field: "currentPage" },
        );
      if (hasClock && hasMinutes)
        this.fail(
          "VALIDATION_ERROR",
          "Supply position hours and minutes or positionMinutes, not both.",
          { field: "position" },
        );
      if (!hasClock && !hasMinutes)
        this.fail(
          "VALIDATION_ERROR",
          "Audiobook progress needs a position in hours and minutes.",
          { field: "position" },
        );
      const positionMinutes = hasClock
        ? this.clock(entry.position, "position", 0, book.durationMinutes!)
        : this.integer(
            entry.positionMinutes,
            "positionMinutes",
            0,
            book.durationMinutes!,
          );
      return { bookId: book.id, positionMinutes };
    }
    if (hasClock || hasMinutes)
      this.fail(
        "VALIDATION_ERROR",
        "Page books take currentPage, not a listening position.",
        { field: "position" },
      );
    return {
      bookId: book.id,
      currentPage: this.integer(
        entry.currentPage,
        "currentPage",
        0,
        book.pageCount!,
      ),
    };
  }
  private validateDraft(d: any, date: string) {
    if (
      !d ||
      !Array.isArray(d.completedTicketIds) ||
      !Array.isArray(d.slippedDestinations) ||
      !Array.isArray(d.bookPages) ||
      !Array.isArray(d.markReadBookIds)
    )
      this.fail("VALIDATION_ERROR", "Invalid review draft collections.");
    for (const v of [
      d.completedTicketIds,
      d.slippedDestinations,
      d.bookPages,
      d.markReadBookIds,
    ])
      if (v.length > 500)
        this.fail(
          "VALIDATION_ERROR",
          "Review collections are limited to 500 entries.",
        );
    const eligible = new Set(this.todayTickets(date).map((t) => t.id));
    if (
      new Set(d.completedTicketIds).size !== d.completedTicketIds.length ||
      d.completedTicketIds.some((id: any) => !eligible.has(id))
    )
      this.fail(
        "VALIDATION_ERROR",
        "Review completed tickets must be unique tickets in this day.",
      );
    const slipped = new Set<string>();
    for (const entry of d.slippedDestinations) {
      if (!eligible.has(entry.ticketId) || slipped.has(entry.ticketId))
        this.fail(
          "VALIDATION_ERROR",
          "Slipped tickets must be unique eligible tickets.",
        );
      slipped.add(entry.ticketId);
      if (
        !entry.destination ||
        !["tomorrow_unbooked", "back_to_todo", "book"].includes(
          entry.destination.kind,
        )
      )
        this.fail("VALIDATION_ERROR", "Unknown slipped destination.");
      if (entry.destination.kind === "book") {
        if (
          localParts(this.instant(entry.destination.start)).date !==
            addDays(date, 1) ||
          localParts(this.instant(entry.destination.end)).date !==
            addDays(date, 1)
        )
          this.fail(
            "VALIDATION_ERROR",
            "Review bookings must be on the resolved tomorrow.",
          );
        if (typeof entry.destination.allowOverlap !== "boolean")
          this.fail(
            "VALIDATION_ERROR",
            "Booking overlap permission must be explicit.",
          );
      }
    }
    const bookIds = new Set<string>();
    const normalized = [];
    for (const entry of d.bookPages) {
      const book = this.item(entry.bookId);
      if (
        book.kind !== "book" ||
        book.state !== "active" ||
        bookIds.has(book.id)
      )
        this.fail(
          "VALIDATION_ERROR",
          "Progress entries must target unique active books.",
        );
      bookIds.add(book.id);
      normalized.push(this.canonicalProgress(entry, book));
    }
    d.bookPages = normalized;
    if (new Set(d.markReadBookIds).size !== d.markReadBookIds.length)
      this.fail("VALIDATION_ERROR", "Duplicate mark-read choice.");
    for (const id of d.markReadBookIds) {
      const book = this.item(id);
      const entry = d.bookPages.find((x: any) => x.bookId === id);
      const atEnd =
        book.progressUnit === "time"
          ? (entry?.positionMinutes ?? book.positionMinutes) ===
            book.durationMinutes
          : (entry?.currentPage ?? book.currentPage) === book.pageCount;
      if (book.kind !== "book" || book.state !== "active" || !atEnd)
        this.fail(
          "VALIDATION_ERROR",
          book.progressUnit === "time"
            ? "Mark as read requires an active audiobook at the end of its length."
            : "Mark as read requires an active book at its last page.",
        );
    }
    if (d.learning) {
      this.text(d.learning.text, "text", 2000);
      const target = d.learning.target;
      if (!target || !["book", "project"].includes(target.kind))
        this.fail("VALIDATION_ERROR", "One learning target is required.");
      const item = this.item(target.id);
      if (item.kind !== target.kind || item.state !== "active")
        this.fail("VALIDATION_ERROR", "Learning target must be active.");
    }
  }
  private updateDraft(a: Row) {
    const date = this.date(a.date);
    this.ensureReviewDay(date);
    const old = this.one("SELECT * FROM reviews WHERE review_date=?", date);
    const patch = a.patch;
    if (
      !patch ||
      typeof patch !== "object" ||
      Object.keys(patch).some(
        (k) =>
          ![
            "completedTicketIds",
            "slippedDestinations",
            "bookPages",
            "markReadBookIds",
            "learning",
          ].includes(k),
      )
    )
      this.fail("VALIDATION_ERROR", "Unknown review patch field.");
    const d = { ...parse(old?.draft_json, this.defaultDraft(date)), ...patch };
    this.validateDraft(d, date);
    const baseline = this.reviewBaseline(date);
    for (const key of Object.keys(baseline)) this.need(key);
    if (old) {
      this.db.run(
        "UPDATE reviews SET draft_json=?,baseline_json=?,updated_at=?,version=version+1 WHERE id=?",
        JSON.stringify(d),
        JSON.stringify(baseline),
        this.at(),
        old.id,
      );
    } else
      this.db.run(
        "INSERT INTO reviews(id,review_date,draft_json,baseline_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        uid("rev"),
        date,
        JSON.stringify(d),
        JSON.stringify(baseline),
        this.at(),
        this.at(),
      );
    return {
      review: this.reviewContext(date),
      summary: "Review draft saved; no tasks or calendar events changed.",
    };
  }
  private saveReview(a: Row) {
    const date = this.date(a.date);
    this.ensureReviewDay(date);
    const r = this.one("SELECT * FROM reviews WHERE review_date=?", date);
    if (!r)
      this.fail(
        "VALIDATION_ERROR",
        "Persist the review draft before saving it.",
      );
    const d = parse<ReviewDraft>(r.draft_json, this.defaultDraft(date));
    this.validateDraft(d, date);
    const baseline = parse<Record<string, string>>(r.baseline_json, {});
    for (const [key, value] of Object.entries(baseline)) {
      this.need(key);
      if (this.ctx!.before[key] !== value)
        this.fail(
          "VERSION_CONFLICT",
          "The draft is stale; reconcile it before saving.",
          { currentVersions: { [key]: this.ctx!.before[key] } },
        );
    }
    const complete = new Set(d.completedTicketIds),
      destinations = new Map(
        d.slippedDestinations.map((x) => [x.ticketId, x.destination]),
      );
    const tickets = this.todayTickets(date);
    for (const t of tickets)
      if (!complete.has(t.id) && !destinations.has(t.id))
        this.fail(
          "VALIDATION_ERROR",
          "Every slipped ticket needs exactly one destination.",
          { ticketId: t.id },
        );
    let done = 0,
      moved = 0,
      pages = 0;
    for (const t of tickets) {
      if (complete.has(t.id)) {
        if (t.status !== "done") {
          this.putStatus(t, "done");
          done++;
        }
        continue;
      }
      const dest = destinations.get(t.id)!;
      if (t.status !== "todo") this.putStatus(t, "todo");
      else {
        this.need(`ticket:${t.id}`);
        this.touch("tickets", t.id, `ticket:${t.id}`);
      }
      this.db.run(
        "UPDATE tickets SET planned_for=? WHERE id=?",
        dest.kind === "back_to_todo" ? null : addDays(date, 1),
        t.id,
      );
      if (dest.kind === "book") {
        const current = this.ticket(t.id);
        if (current.currentBookingId) {
          const b = this.booking(current.currentBookingId);
          if (Date.parse(b.start) <= this.at()) {
            this.db.run(
              "UPDATE bookings SET retired_at=? WHERE id=?",
              this.at(),
              b.id,
            );
            this.touch("bookings", b.id, `booking:${b.id}`);
            this.db.run(
              "UPDATE tickets SET current_booking_id=NULL WHERE id=?",
              t.id,
            );
          } else if (Date.parse(b.end) > this.at()) {
            this.moveBooking(
              b,
              this.instant(dest.start),
              this.instant(dest.end),
              dest.allowOverlap,
              false,
            );
            moved++;
            continue;
          }
        }
        this.createBooking(
          this.ticket(t.id),
          this.instant(dest.start),
          this.instant(dest.end),
          dest.allowOverlap,
          false,
        );
      }
      moved++;
    }
    for (const entry of d.bookPages) {
      const b = this.item(entry.bookId);
      if (
        b.progressUnit === "time" &&
        entry.positionMinutes !== b.positionMinutes
      ) {
        this.db.run(
          "UPDATE books SET position_minutes=? WHERE id=?",
          entry.positionMinutes,
          b.id,
        );
        this.itemTouch(b);
        pages++;
      } else if (
        b.progressUnit !== "time" &&
        entry.currentPage !== b.currentPage
      ) {
        this.db.run(
          "UPDATE books SET current_page=? WHERE id=?",
          entry.currentPage,
          b.id,
        );
        this.itemTouch(b);
        pages++;
      }
    }
    for (const id of d.markReadBookIds) this.vacate(this.item(id), "done");
    if (d.learning)
      this.addLearning(d.learning.text, d.learning.target, r.id, date);
    this.db.run(
      "UPDATE reviews SET saved_json=?,saved_at=?,draft_json=NULL,updated_at=?,version=version+1 WHERE id=?",
      JSON.stringify(d),
      this.at(),
      this.at(),
      r.id,
    );
    return {
      summary: "Review saved. Good night.",
      review: this.reviewContext(date),
      effects: {
        ticketsDone: done,
        ticketsMoved: moved,
        pageUpdates: pages,
        learnings: d.learning ? 1 : 0,
      },
    };
  }
  private mutate(tool: string, a: Row): Row {
    switch (tool) {
      case "queue_project":
        return this.queueProject(a);
      case "queue_book":
        return this.queueBook(a);
      case "update_project": {
        const i = this.item(a.projectId);
        if (i.kind !== "project")
          this.fail("VALIDATION_ERROR", "A project is required.");
        this.editable(i);
        this.need(`item:${i.id}`);
        const p = a.patch;
        if (!p || Object.keys(p).some((k) => !["title", "goal"].includes(k)))
          this.fail("VALIDATION_ERROR", "Unknown project patch field.");
        if (p.title !== undefined)
          this.db.run(
            "UPDATE projects SET title=? WHERE id=?",
            this.text(p.title, "title"),
            i.id,
          );
        if (p.goal !== undefined)
          this.db.run(
            "UPDATE projects SET goal=? WHERE id=?",
            p.goal === null ? null : this.text(p.goal, "goal", 2000),
            i.id,
          );
        this.itemTouch(i);
        return { item: this.item(i.id), summary: "Project updated." };
      }
      case "update_book": {
        const i = this.item(a.bookId);
        if (i.kind !== "book")
          this.fail("VALIDATION_ERROR", "A book is required.");
        this.editable(i);
        this.need(`item:${i.id}`);
        const p = a.patch;
        if (
          !p ||
          Object.keys(p).some(
            (k) => !["title", "authors", "pageCount", "duration"].includes(k),
          )
        )
          this.fail("VALIDATION_ERROR", "Unknown book patch field.");
        if (p.pageCount !== undefined && i.progressUnit === "time")
          this.fail(
            "VALIDATION_ERROR",
            "Audiobooks use a duration, not a page count.",
            { field: "pageCount" },
          );
        if (p.duration !== undefined && i.progressUnit !== "time")
          this.fail(
            "VALIDATION_ERROR",
            "Page books use a page count, not a duration.",
            { field: "duration" },
          );
        if (p.title !== undefined)
          this.db.run(
            "UPDATE books SET title=? WHERE id=?",
            this.text(p.title, "title"),
            i.id,
          );
        if (p.authors !== undefined)
          this.db.run(
            "UPDATE books SET authors_json=? WHERE id=?",
            JSON.stringify(this.authors(p.authors)),
            i.id,
          );
        if (p.pageCount !== undefined) {
          const pages = this.integer(p.pageCount, "pageCount", 1, 100000);
          this.db.run(
            "UPDATE books SET page_count=?,current_page=MIN(current_page,?),page_count_source='manual' WHERE id=?",
            pages,
            pages,
            i.id,
          );
        }
        if (p.duration !== undefined) {
          const length = this.clock(p.duration, "duration", 1);
          this.db.run(
            "UPDATE books SET duration_minutes=?,position_minutes=MIN(position_minutes,?) WHERE id=?",
            length,
            length,
            i.id,
          );
        }
        this.itemTouch(i);
        return { item: this.item(i.id), summary: "Book updated." };
      }
      case "set_book_progress": {
        const i = this.item(a.bookId);
        if (i.kind !== "book")
          this.fail("VALIDATION_ERROR", "A book is required.");
        this.active(i);
        this.need(`item:${i.id}`);
        const hasPage = a.currentPage !== undefined;
        const hasPosition = a.position !== undefined;
        if (hasPage === hasPosition)
          this.fail(
            "VALIDATION_ERROR",
            hasPage
              ? "Set either currentPage or position, not both."
              : "Set currentPage for a page book or position hours and minutes for an audiobook.",
          );
        if (i.progressUnit === "time") {
          if (hasPage)
            this.fail(
              "VALIDATION_ERROR",
              "This audiobook tracks time. Set position in hours and minutes.",
              { field: "currentPage" },
            );
          const position = this.clock(
            a.position,
            "position",
            0,
            i.durationMinutes!,
          );
          this.db.run(
            "UPDATE books SET position_minutes=? WHERE id=?",
            position,
            i.id,
          );
          this.itemTouch(i);
          const item = this.item(i.id);
          return {
            item,
            canFinish: position === i.durationMinutes,
            progressPercent: progressPercent(position, i.durationMinutes!),
            summary: "Listening progress saved.",
          };
        }
        if (hasPosition)
          this.fail(
            "VALIDATION_ERROR",
            "This book tracks pages. Set currentPage.",
            { field: "position" },
          );
        const page = this.integer(
          a.currentPage,
          "currentPage",
          0,
          i.pageCount!,
        );
        this.db.run("UPDATE books SET current_page=? WHERE id=?", page, i.id);
        this.itemTouch(i);
        return {
          item: this.item(i.id),
          canFinish: page === i.pageCount,
          progressPercent: progressPercent(page, i.pageCount!),
          summary: "Reading progress saved.",
        };
      }
      case "start_item":
      case "resume_item": {
        const item = this.item(a.itemId);
        this.start(item, tool === "resume_item");
        return {
          item: this.item(item.id),
          summary: tool === "start_item" ? "Item started." : "Item resumed.",
        };
      }
      case "pause_item":
      case "finish_item":
      case "archive_item": {
        const item = this.item(a.itemId);
        this.vacate(
          item,
          tool === "pause_item"
            ? "paused"
            : tool === "finish_item"
              ? "done"
              : "archived",
        );
        return {
          item: this.item(item.id),
          summary:
            tool === "pause_item"
              ? "Paused; the place is open."
              : tool === "finish_item"
                ? "Done; the place is open."
                : "Archived; the place is open.",
        };
      }
      case "restore_item": {
        const item = this.item(a.itemId);
        this.need(`item:${item.id}`);
        this.need(`queue:${item.areaId}`);
        if (item.state !== "archived")
          this.fail(
            "INVALID_TRANSITION",
            "Only archived items restore to Up next.",
          );
        this.db.run(
          `UPDATE ${item.kind === "project" ? "projects" : "books"} SET state='queued' WHERE id=?`,
          item.id,
        );
        if (item.kind === "project")
          for (const r of this.db.all(
            "SELECT * FROM tickets WHERE project_id=? AND status='in_progress'",
            item.id,
          )) {
            this.db.run(
              "UPDATE tickets SET status='todo',planned_for=NULL WHERE id=?",
              r.id,
            );
            this.touch("tickets", r.id, `ticket:${r.id}`);
            this.bumpAggregate(`tickets:${item.id}:todo`);
            this.bumpAggregate(`tickets:${item.id}:in_progress`);
          }
        this.itemTouch(item);
        this.appendQueue(item);
        return { item: this.item(item.id), summary: "Restored to Up next." };
      }
      case "replace_active_item": {
        const current = this.item(a.currentItemId),
          next = this.item(a.nextItemId);
        if (
          current.id === next.id ||
          current.kind !== next.kind ||
          current.areaId !== next.areaId ||
          next.state !== "queued"
        )
          this.fail(
            "INVALID_TRANSITION",
            "Replacement must be a queued item of the same area and kind.",
          );
        if (!["pause", "finish", "archive"].includes(a.disposition))
          this.fail("VALIDATION_ERROR", "Choose pause, finish, or archive.");
        this.need(`item:${next.id}`);
        this.need(`queue:${next.areaId}`);
        this.vacate(
          current,
          a.disposition === "pause"
            ? "paused"
            : a.disposition === "finish"
              ? "done"
              : "archived",
        );
        this.start(next);
        return {
          item: this.item(next.id),
          previous: this.item(current.id),
          summary: "Current place released and replacement started atomically.",
        };
      }
      case "reorder_up_next": {
        const area = this.area(a.areaId),
          item = this.item(a.itemId);
        this.need(`queue:${area}`);
        if (item.state !== "queued" || item.areaId !== area)
          this.fail(
            "INVALID_TRANSITION",
            "Only queued items in this area can be reordered.",
          );
        const rows = this.db.all(
            "SELECT * FROM queue_entries WHERE area_id=? ORDER BY position,id",
            area,
          ),
          target = rows.find(
            (r) => r.project_id === item.id || r.book_id === item.id,
          );
        const ids = rows
          .map((r) => r.project_id ?? r.book_id)
          .filter((id) => id !== item.id);
        if (a.beforeItemId !== null && !ids.includes(a.beforeItemId))
          this.fail(
            "VALIDATION_ERROR",
            "The anchor must be another queued item in this area.",
          );
        ids.splice(
          a.beforeItemId === null ? ids.length : ids.indexOf(a.beforeItemId),
          0,
          item.id,
        );
        for (const [i, id] of ids.entries())
          this.db.run(
            "UPDATE queue_entries SET position=? WHERE project_id=? OR book_id=?",
            -i - 1,
            id,
            id,
          );
        for (const [i, id] of ids.entries())
          this.db.run(
            "UPDATE queue_entries SET position=? WHERE project_id=? OR book_id=?",
            i,
            id,
            id,
          );
        if (!target) this.fail("INVALID_TRANSITION", "Queue entry missing.");
        this.bumpAggregate(`queue:${area}`);
        return { summary: "Up next reordered." };
      }
      case "create_ticket": {
        const p = this.item(a.projectId);
        if (p.kind !== "project")
          this.fail("VALIDATION_ERROR", "A project is required.");
        this.editable(p);
        this.need(`item:${p.id}`);
        this.need(`tickets:${p.id}:todo`);
        const t = this.newTicket(p.id, a.title);
        this.itemTouch(p);
        return { ticket: t, summary: "Ticket added." };
      }
      case "update_ticket": {
        const t = this.ticket(a.ticketId),
          p = this.item(t.projectId);
        this.editable(p);
        this.need(`ticket:${t.id}`);
        this.need(`item:${p.id}`);
        const title = this.text(a.title, "title", 500);
        this.db.run("UPDATE tickets SET title=? WHERE id=?", title, t.id);
        this.touch("tickets", t.id, `ticket:${t.id}`);
        this.itemTouch(p);
        if (t.currentBookingId) {
          const b = this.booking(t.currentBookingId);
          if (
            b.desiredPresence === "present" &&
            Date.parse(b.end) > this.at()
          ) {
            this.need(`booking:${b.id}`);
            this.db.run(
              "UPDATE bookings SET sync_state='pending' WHERE id=?",
              b.id,
            );
            this.touch("bookings", b.id, `booking:${b.id}`);
            this.db.run(
              "UPDATE outbox_operations SET state='superseded',version=version+1,updated_at=? WHERE booking_id=? AND action='update' AND json_extract(payload_json,'$.start') IS NULL AND state IN ('pending','waiting_retry','needs_reconnect','failed')",
              this.at(),
              b.id,
            );
            this.enqueue("update", this.booking(b.id), b.accountId, {
              summary: title,
            });
          }
        }
        return { ticket: this.ticket(t.id), summary: "Ticket title updated." };
      }
      case "set_ticket_status": {
        const t = this.ticket(a.ticketId);
        this.putStatus(t, a.status, a.beforeTicketId);
        return { ticket: this.ticket(t.id), summary: "Ticket status saved." };
      }
      case "set_ticket_day": {
        const t = this.ticket(a.ticketId),
          p = this.item(t.projectId);
        this.active(p);
        if (t.status === "closed" || t.status === "done")
          this.fail(
            "TICKET_NOT_ACTIONABLE",
            "Only open tickets can be planned.",
          );
        this.need(`ticket:${t.id}`);
        this.need(`item:${p.id}`);
        this.db.run(
          "UPDATE tickets SET planned_for=? WHERE id=?",
          a.plannedFor === null ? null : this.date(a.plannedFor),
          t.id,
        );
        this.touch("tickets", t.id, `ticket:${t.id}`);
        this.itemTouch(p);
        return { ticket: this.ticket(t.id), summary: "Ticket plan saved." };
      }
      case "reorder_tickets": {
        const p = this.item(a.projectId),
          t = this.ticket(a.ticketId);
        this.editable(p);
        this.need(`tickets:${p.id}:${a.status}`);
        this.need(`ticket:${t.id}`);
        if (t.projectId !== p.id || t.status !== a.status)
          this.fail(
            "VALIDATION_ERROR",
            "Ticket must belong to this project and column.",
          );
        this.orderTickets(p.id, a.status, t.id, a.beforeTicketId);
        return { summary: "Tickets reordered." };
      }
      case "add_learning":
        return {
          learning: this.addLearning(a.text, a.target),
          summary: "Learning saved on its item.",
        };
      case "book_ticket":
        return {
          booking: this.createBooking(
            this.ticket(a.ticketId),
            this.instant(a.start),
            this.instant(a.end),
            a.allowOverlap === true,
            a.acceptIncompleteAvailability === true,
          ),
          summary: "Booking pending on Personal calendar.",
        };
      case "move_booking": {
        const b = this.booking(a.bookingId);
        return {
          booking: this.moveBooking(
            b,
            this.instant(a.start),
            this.instant(a.end),
            a.allowOverlap === true,
            a.acceptIncompleteAvailability === true,
          ),
          summary: "Calendar move pending.",
        };
      }
      case "resize_booking": {
        const b = this.booking(a.bookingId);
        return {
          booking: this.moveBooking(
            b,
            Date.parse(b.start),
            this.instant(a.end),
            false,
            false,
          ),
          summary: "Calendar resize pending.",
        };
      }
      case "remove_booking": {
        const b = this.booking(a.bookingId);
        this.cancelBooking(b);
        return {
          booking: this.booking(b.id),
          summary: "Calendar removal pending.",
        };
      }
      case "update_review_draft":
        return this.updateDraft(a);
      case "save_review":
        return this.saveReview(a);
      case "dismiss_skipped_review_note": {
        const date = this.date(a.date);
        if (date !== localParts(this.at()).date)
          this.fail("VALIDATION_ERROR", "Dismiss only the current day note.");
        this.db.run(
          "INSERT OR IGNORE INTO daily_dismissals(local_date,dismissed_at) VALUES(?,?)",
          date,
          this.at(),
        );
        return { summary: "Skipped-review note dismissed." };
      }
      case "request_calendar_sync": {
        const accounts = this.db
          .all("SELECT * FROM calendar_accounts")
          .filter((r) => !a.role || r.role === a.role);
        if (a.role && !["personal", "work"].includes(a.role))
          this.fail("VALIDATION_ERROR", "Unknown calendar role.");
        for (const acc of accounts) {
          const existing = this.one(
            "SELECT id FROM outbox_operations WHERE account_id=? AND action='sync' AND state IN ('pending','running','waiting_retry')",
            acc.id,
          );
          if (existing) this.ctx!.operations.push(existing.id);
          else
            this.enqueue(
              "sync",
              null,
              acc.id,
              { calendarIds: parse(acc.calendar_ids_json, []) },
              "calendar:busy:read",
            );
        }
        return { summary: "Calendar synchronization requested." };
      }
      case "retry_operation":
        return this.retryOperation(a);
      case "undo_booking_change":
        return this.undoOperation(a);
      default:
        return this.fail("NOT_FOUND", "Unknown mutation.");
    }
  }
  private retryOperation(a: Row) {
    const op = this.one(
      "SELECT * FROM outbox_operations WHERE id=?",
      String(a.operationId),
    );
    if (!op) this.fail("NOT_FOUND", "Operation not found.");
    this.scope(this.ctx!.actor, op.required_scope);
    this.need(`operation:${op.id}`);
    if (!["failed", "needs_reconnect", "waiting_retry"].includes(op.state))
      this.fail(
        "OPERATION_NOT_RETRYABLE",
        "Only failed/reconnect/retry-wait work can be retried.",
      );
    const acc = this.one(
      "SELECT status FROM calendar_accounts WHERE id=?",
      op.account_id,
    );
    if (acc?.status !== "connected")
      this.fail("RECONNECT_REQUIRED", "Reconnect this account first.");
    if (op.booking_id) {
      const b = this.booking(op.booking_id);
      this.need(`booking:${b.id}`);
      const payload = parse(op.payload_json, {});
      const stillIntended =
        b.desiredPresence === "present" &&
        (!payload.start || payload.start === b.start) &&
        (!payload.end || payload.end === b.end) &&
        (!payload.summary || payload.summary === this.ticket(b.ticketId).title);
      if (
        Number(b.version) !== op.target_booking_version &&
        !(
          op.action === "create" &&
          b.desiredPresence === "present" &&
          this.ticket(b.ticketId).currentBookingId === b.id
        ) &&
        !stillIntended
      )
        this.fail(
          "VERSION_CONFLICT",
          "This operation was superseded by a newer booking decision.",
        );
    }
    this.db.run(
      "UPDATE outbox_operations SET state='pending',next_attempt_at=?,error_code=NULL,error_message=NULL,version=version+1,updated_at=? WHERE id=?",
      this.at(),
      this.at(),
      op.id,
    );
    this.ctx!.operations.push(op.id);
    return { summary: "Operation queued for retry." };
  }
  private undoOperation(a: Row) {
    const op = this.one(
      "SELECT * FROM outbox_operations WHERE id=?",
      String(a.operationId),
    );
    if (!op) this.fail("NOT_FOUND", "Operation not found.");
    this.need(`operation:${op.id}`);
    if (
      !op.booking_id ||
      !["create", "update"].includes(op.action) ||
      !["failed", "needs_reconnect", "pending", "waiting_retry"].includes(
        op.state,
      ) ||
      op.required_scope !== "calendar:book"
    )
      this.fail("UNDO_UNAVAILABLE", "This operation does not support Undo.");
    const b = this.booking(op.booking_id);
    this.need(`booking:${b.id}`);
    if (Number(b.version) !== op.target_booking_version)
      this.fail(
        "UNDO_UNAVAILABLE",
        "A later change superseded this operation.",
      );
    this.actionableBooking(b);
    if (op.action === "create") this.cancelBooking(b);
    else {
      const payload = parse(op.payload_json, {});
      if (!payload.before)
        this.fail(
          "UNDO_UNAVAILABLE",
          "No prior confirmed interval is available.",
        );
      this.moveBooking(
        b,
        this.instant(payload.before.start),
        this.instant(payload.before.end),
        false,
        true,
      );
    }
    return { summary: "Compensating calendar operation pending." };
  }
  private internal<T>(name: string, fn: () => T): T {
    return this.db.transaction(() => {
      const previous = this.ctx;
      this.ctx = {
        actor: { id: "system", type: "system", scopes: [] },
        tool: name,
        args: {},
        at: this.now(),
        commandId: uid("sys"),
        before: {},
        required: {},
        touched: new Set(),
        operations: [],
        entities: [],
        preview: true,
        system: true,
        watermark: this.watermarks(),
      };
      try {
        const result = fn();
        this.bumpAggregate("owner");
        this.db.run(
          "INSERT INTO audit_log(id,command_id,actor_id,actor_type,action,entity_ids_json,summary,occurred_at) VALUES(?,NULL,'system','system',?,?,?,?)",
          uid("chg"),
          name,
          JSON.stringify(this.ctx.entities),
          name,
          this.at(),
        );
        return result;
      } finally {
        this.ctx = previous;
      }
    });
  }
  connectAccount(input: AccountInput): Connection {
    return this.internal("calendar_connected", () => {
      if (!["personal", "work"].includes(input.role))
        this.fail("VALIDATION_ERROR", "Unknown calendar role.");
      this.text(input.email, "email", 320);
      this.text(input.encryptedCredentials, "encryptedCredentials", 50000);
      const existing = this.one(
        "SELECT * FROM calendar_accounts WHERE role=?",
        input.role,
      );
      if (
        existing?.google_subject &&
        input.googleSubject &&
        existing.google_subject !== input.googleSubject
      )
        this.fail(
          "ACCOUNT_IDENTITY_CONFLICT",
          "Reconnect the same Google account; replacing its identity requires an explicit migration.",
        );
      const id = existing?.id ?? input.id ?? uid("acct");
      const calendars = [...new Set(input.calendarIds ?? ["primary"])];
      const write =
        input.role === "personal" ? (input.writeCalendarId ?? "primary") : null;
      if (write && !calendars.includes(write)) calendars.push(write);
      if (
        calendars.length < 1 ||
        calendars.length > 20 ||
        calendars.some((c) => typeof c !== "string" || !c || c.length > 500)
      )
        this.fail("VALIDATION_ERROR", "Choose 1–20 valid calendars.");
      if (existing)
        this.db.run(
          "UPDATE calendar_accounts SET email=?,encrypted_credentials=?,google_subject=COALESCE(?,google_subject),calendar_ids_json=?,write_calendar_id=?,status='connected',updated_at=?,version=version+1 WHERE id=?",
          input.email,
          input.encryptedCredentials,
          input.googleSubject ?? null,
          JSON.stringify(calendars),
          write,
          this.at(),
          id,
        );
      else
        this.db.run(
          "INSERT INTO calendar_accounts(id,role,google_subject,email,encrypted_credentials,calendar_ids_json,write_calendar_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'connected',?,?)",
          id,
          input.role,
          input.googleSubject ?? null,
          input.email,
          input.encryptedCredentials,
          JSON.stringify(calendars),
          write,
          this.at(),
          this.at(),
        );
      for (const cal of calendars)
        this.db.run(
          "INSERT OR IGNORE INTO calendar_sources(account_id,calendar_id) VALUES(?,?)",
          id,
          cal,
        );
      this.db.run(
        "UPDATE outbox_operations SET state='pending',next_attempt_at=?,version=version+1,updated_at=? WHERE account_id=? AND state='needs_reconnect'",
        this.at(),
        this.at(),
        id,
      );
      return this.mapConnection(
        this.one("SELECT * FROM calendar_accounts WHERE id=?", id)!,
      );
    });
  }
  getAccountCredentials(role: CalendarRole): {
    id: string;
    role: CalendarRole;
    email: string;
    encryptedCredentials: string;
    calendarIds: string[];
    writeCalendarId?: string;
    status: string;
    sources: {
      calendarId: string;
      syncToken?: string;
      lastSyncedAt?: string;
    }[];
  } | null {
    const a = this.one("SELECT * FROM calendar_accounts WHERE role=?", role);
    return a
      ? {
          id: a.id,
          role: a.role,
          email: a.email,
          encryptedCredentials: a.encrypted_credentials,
          calendarIds: parse(a.calendar_ids_json, []),
          writeCalendarId: a.write_calendar_id ?? undefined,
          status: a.status,
          sources: this.db
            .all("SELECT * FROM calendar_sources WHERE account_id=?", a.id)
            .filter((r) =>
              parse(a.calendar_ids_json, []).includes(r.calendar_id),
            )
            .map((r) => ({
              calendarId: r.calendar_id,
              syncToken: r.sync_token ?? undefined,
              lastSyncedAt: iso(r.last_synced_at),
            })),
        }
      : null;
  }
  updateAccountCredentials(
    role: CalendarRole,
    encryptedCredentials: string,
  ): void {
    this.internal("calendar_credentials_refreshed", () => {
      this.db.run(
        "UPDATE calendar_accounts SET encrypted_credentials=?,updated_at=CASE WHEN status='connected' THEN ? ELSE updated_at END,version=version+1 WHERE role=?",
        this.text(encryptedCredentials, "encryptedCredentials", 50000),
        this.at(),
        role,
      );
    });
  }
  setAccountStatus(
    role: CalendarRole,
    status: "connected" | "needs_reconnect" | "error",
  ): void {
    this.internal("calendar_account_status", () => {
      if (!["connected", "needs_reconnect", "error"].includes(status))
        this.fail("VALIDATION_ERROR", "Invalid account state.");
      const a = this.one("SELECT * FROM calendar_accounts WHERE role=?", role);
      if (!a) return;
      this.db.run(
        "UPDATE calendar_accounts SET status=?,updated_at=CASE WHEN status<>? THEN ? ELSE updated_at END,version=version+1 WHERE id=?",
        status,
        status,
        this.at(),
        a.id,
      );
      if (status === "needs_reconnect")
        this.db.run(
          "UPDATE outbox_operations SET state='needs_reconnect',version=version+1,updated_at=? WHERE account_id=? AND state IN ('pending','running','waiting_retry')",
          this.at(),
          a.id,
        );
    });
  }
  reconcileCalendar(input: ReconcileInput): void {
    this.internal("calendar_reconciled", () => {
      const account = this.one(
        "SELECT * FROM calendar_accounts WHERE role=?",
        input.role,
      );
      if (!account)
        this.fail("NOT_FOUND", "Calendar account is not connected.");
      if (!parse(account.calendar_ids_json, []).includes(input.calendarId))
        this.fail(
          "VALIDATION_ERROR",
          "Calendar is not selected for this account.",
        );
      const synced = input.syncedAt ?? this.at();
      if (input.replace) {
        if (input.replaceRange) {
          const start = this.instant(input.replaceRange.start),
            end = this.instant(input.replaceRange.end);
          const firstDate = localParts(start).date,
            endParts = localParts(end),
            lastDate =
              endParts.hour === 0 && endParts.minute === 0
                ? endParts.date
                : addDays(endParts.date, 1);
          // Split timed and all-day deletes so each predicate can use its index.
          // A single OR of the two ranges cannot.
          this.db.run(
            "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE account_id=? AND calendar_id=? AND all_day=0 AND start_utc<? AND end_utc>?)",
            account.id,
            input.calendarId,
            end,
            start,
          );
          this.db.run(
            "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE account_id=? AND calendar_id=? AND all_day=1 AND start_date<? AND end_date>?)",
            account.id,
            input.calendarId,
            lastDate,
            firstDate,
          );
        } else
          this.db.run(
            "DELETE FROM calendar_events WHERE account_id=? AND calendar_id=?",
            account.id,
            input.calendarId,
          );
      }
      for (const event of input.events) {
        const id = event.googleEventId ?? event.id;
        if (!id)
          this.fail("VALIDATION_ERROR", "A provider event ID is required.");
        const existing = this.one(
          "SELECT * FROM calendar_events WHERE account_id=? AND calendar_id=? AND google_event_id=?",
          account.id,
          input.calendarId,
          id,
        );
        const booking = this.one(
          "SELECT * FROM bookings WHERE account_id=? AND calendar_id=? AND google_event_id=?",
          account.id,
          input.calendarId,
          id,
        );
        if (event.deleted) {
          if (existing)
            this.db.run(
              "UPDATE calendar_events SET deleted_at=?,cached_at=? WHERE account_id=? AND calendar_id=? AND google_event_id=?",
              synced,
              synced,
              account.id,
              input.calendarId,
              id,
            );
          if (booking) {
            this.db.run(
              "UPDATE bookings SET provider_deleted_at=?,desired_presence='absent',sync_state='synced',retired_at=COALESCE(retired_at,?) WHERE id=?",
              synced,
              synced,
              booking.id,
            );
            this.db.run(
              "UPDATE tickets SET current_booking_id=NULL WHERE id=? AND current_booking_id=?",
              booking.ticket_id,
              booking.id,
            );
            this.touch("bookings", booking.id, `booking:${booking.id}`);
            this.touch(
              "tickets",
              booking.ticket_id,
              `ticket:${booking.ticket_id}`,
            );
            this.supersede(booking.id);
          }
          continue;
        }
        const allDay = !!event.allDay;
        const start = allDay ? null : this.instant(event.start),
          end = allDay ? null : this.instant(event.end);
        if (!allDay && end! <= start!)
          this.fail("VALIDATION_ERROR", "Provider end must follow start.");
        const sd = allDay ? this.date(event.startDate) : null,
          ed = allDay ? this.date(event.endDate) : null;
        if (allDay && ed! <= sd!)
          this.fail(
            "VALIDATION_ERROR",
            "Provider end date must follow start date.",
          );
        this.db.run(
          "INSERT INTO calendar_events(account_id,calendar_id,google_event_id,title,start_utc,end_utc,all_day,start_date,end_date,is_busy,etag,deleted_at,cached_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?) ON CONFLICT(account_id,calendar_id,google_event_id) DO UPDATE SET title=excluded.title,start_utc=excluded.start_utc,end_utc=excluded.end_utc,all_day=excluded.all_day,start_date=excluded.start_date,end_date=excluded.end_date,is_busy=excluded.is_busy,etag=excluded.etag,deleted_at=NULL,cached_at=excluded.cached_at",
          account.id,
          input.calendarId,
          id,
          event.title ?? "",
          start,
          end,
          allDay ? 1 : 0,
          sd,
          ed,
          event.isBusy === false ? 0 : 1,
          event.etag ?? null,
          synced,
        );
        if (booking && !allDay) {
          const pending = this.db.all(
            "SELECT * FROM outbox_operations WHERE booking_id=? AND state IN ('pending','running','waiting_retry','needs_reconnect')",
            booking.id,
          );
          const changed =
            booking.remote_etag &&
            event.etag &&
            booking.remote_etag !== event.etag;
          const matches =
            booking.start_utc === start && booking.end_utc === end;
          const remoteChanged =
            booking.remote_start_utc !== start ||
            booking.remote_end_utc !== end ||
            booking.remote_etag !== (event.etag ?? null) ||
            booking.provider_deleted_at != null;
          this.db.run(
            "UPDATE bookings SET remote_start_utc=?,remote_end_utc=?,remote_etag=?,provider_deleted_at=NULL WHERE id=?",
            start,
            end,
            event.etag ?? null,
            booking.id,
          );
          if (
            booking.desired_presence === "present" &&
            (!pending.length || (changed && !matches))
          ) {
            this.db.run(
              "UPDATE bookings SET start_utc=?,end_utc=?,sync_state='synced' WHERE id=?",
              start,
              end,
              booking.id,
            );
            if (pending.length)
              this.db.run(
                "UPDATE outbox_operations SET state='failed',error_code='VERSION_CONFLICT',error_message='Google changed this event; read current versions before issuing another change.',version=version+1,updated_at=? WHERE booking_id=? AND state IN ('pending','running','waiting_retry','needs_reconnect')",
                this.at(),
                booking.id,
              );
          }
          if (
            remoteChanged &&
            (!pending.length ||
              (changed && !matches) ||
              booking.desired_presence === "absent")
          )
            this.touch("bookings", booking.id, `booking:${booking.id}`);
          if (
            booking.desired_presence === "absent" &&
            !pending.some((op) => op.action === "delete")
          ) {
            this.supersede(booking.id);
            this.db.run(
              "UPDATE bookings SET sync_state='pending' WHERE id=?",
              booking.id,
            );
            this.touch("bookings", booking.id, `booking:${booking.id}`);
            this.enqueue(
              "delete",
              this.booking(booking.id),
              account.id,
              {},
              "calendar:book",
            );
          }
        }
      }
      if (input.partial) return;
      this.db.run(
        "INSERT INTO calendar_sources(account_id,calendar_id,sync_token,last_synced_at) VALUES(?,?,?,?) ON CONFLICT(account_id,calendar_id) DO UPDATE SET sync_token=COALESCE(excluded.sync_token,sync_token),last_synced_at=excluded.last_synced_at",
        account.id,
        input.calendarId,
        input.syncToken ?? null,
        synced,
      );
      const sources = this.db
        .all("SELECT * FROM calendar_sources WHERE account_id=?", account.id)
        .filter((r) =>
          parse(account.calendar_ids_json, []).includes(r.calendar_id),
        );
      const last = sources.every((r) => r.last_synced_at != null)
        ? Math.min(...sources.map((r) => r.last_synced_at))
        : null;
      this.db.run(
        "UPDATE calendar_accounts SET last_synced_at=?,status='connected',updated_at=?,version=version+1 WHERE id=?",
        last,
        this.at(),
        account.id,
      );
    });
  }
  dueOperations(limit = 10): Operation[] {
    return this.db
      .all(
        "SELECT * FROM outbox_operations WHERE (state IN ('pending','waiting_retry') AND next_attempt_at<=?) OR (state='running' AND lease_until<=?) ORDER BY created_at,rowid LIMIT ?",
        this.now(),
        this.now(),
        limit,
      )
      .map((r) => this.mapOperation(r));
  }
  operationPayload(id: string): {
    operation: Operation;
    action: string;
    payload: Row;
    booking: Booking | null;
    ticket: Ticket | null;
    project: Item | null;
    account: ReturnType<OrganizerEngine["getAccountCredentials"]>;
    expectedRemoteEtag?: string;
  } | null {
    const op = this.one("SELECT * FROM outbox_operations WHERE id=?", id);
    if (!op) return null;
    const account = this.one(
      "SELECT role FROM calendar_accounts WHERE id=?",
      op.account_id,
    );
    const booking = op.booking_id ? this.booking(op.booking_id) : null;
    const ticket = booking ? this.ticket(booking.ticketId) : null;
    return {
      operation: this.mapOperation(op),
      action: op.action,
      payload: parse(op.payload_json, {}),
      booking,
      ticket,
      project: ticket ? this.item(ticket.projectId) : null,
      account: account ? this.getAccountCredentials(account.role) : null,
      expectedRemoteEtag: op.booking_id
        ? (this.one(
            "SELECT remote_etag FROM bookings WHERE id=?",
            op.booking_id,
          )?.remote_etag ?? undefined)
        : undefined,
    };
  }
  claimOperation(id: string): ReturnType<OrganizerEngine["operationPayload"]> {
    return this.internal("calendar_operation_claimed", () => {
      const op = this.one(
        "SELECT rowid AS sequence,* FROM outbox_operations WHERE id=?",
        id,
      );
      if (
        !op ||
        inactiveOps.has(op.state) ||
        op.state === "needs_reconnect" ||
        op.next_attempt_at > this.at() ||
        (op.state === "running" && op.lease_until > this.at())
      )
        return null;
      if (op.booking_id) {
        const earlier = this.one(
          `SELECT id FROM outbox_operations WHERE booking_id=? AND rowid<? AND state IN ${BLOCKING_OPERATION_STATES}`,
          op.booking_id,
          op.sequence,
        );
        if (earlier) return null;
      }
      this.db.run(
        "UPDATE outbox_operations SET state='running',attempt_count=attempt_count+1,lease_until=?,updated_at=?,version=version+1 WHERE id=?",
        this.at() + 60000,
        this.at(),
        id,
      );
      return this.operationPayload(id);
    });
  }
  completeOperation(
    id: string,
    result: { remoteEvent?: RemoteEvent } = {},
  ): void {
    this.internal("calendar_operation_succeeded", () => {
      const op = this.one("SELECT * FROM outbox_operations WHERE id=?", id);
      if (!op || op.state === "superseded") return;
      const event = result.remoteEvent;
      if (op.booking_id) {
        const b = this.one("SELECT * FROM bookings WHERE id=?", op.booking_id)!;
        const targetStillCurrent =
          Number(b.version) === op.target_booking_version;
        if (
          event &&
          !event.deleted &&
          !event.allDay &&
          event.start &&
          event.end
        ) {
          const start = this.instant(event.start),
            end = this.instant(event.end);
          this.db.run(
            "UPDATE bookings SET remote_start_utc=?,remote_end_utc=?,remote_etag=? WHERE id=?",
            start,
            end,
            event.etag ?? null,
            b.id,
          );
          // A retry may find the original insert after the owner moved it in Google.
          // Adopt that observed interval only if no newer local command owns the intent.
          if (targetStillCurrent && b.desired_presence === "present")
            this.db.run(
              "UPDATE bookings SET start_utc=?,end_utc=? WHERE id=?",
              start,
              end,
              b.id,
            );
        }
        if (
          targetStillCurrent ||
          (op.action === "delete" && b.desired_presence === "absent")
        ) {
          this.db.run(
            "UPDATE bookings SET sync_state='synced' WHERE id=?",
            b.id,
          );
          if (op.action === "delete") {
            this.db.run(
              "UPDATE bookings SET provider_deleted_at=? WHERE id=?",
              this.at(),
              b.id,
            );
            this.db.run(
              "UPDATE calendar_events SET deleted_at=? WHERE account_id=? AND calendar_id=? AND google_event_id=?",
              this.at(),
              b.account_id,
              b.calendar_id,
              b.google_event_id,
            );
          }
          this.touch("bookings", b.id, `booking:${b.id}`);
        }
      }
      this.db.run(
        "UPDATE outbox_operations SET state='succeeded',lease_until=NULL,error_code=NULL,error_message=NULL,updated_at=?,version=version+1 WHERE id=?",
        this.at(),
        id,
      );
    });
  }
  failOperation(
    id: string,
    error: {
      code: string;
      message: string;
      retryable?: boolean;
      needsReconnect?: boolean;
    },
  ): void {
    this.internal("calendar_operation_failed", () => {
      const op = this.one("SELECT * FROM outbox_operations WHERE id=?", id);
      if (!op || op.state === "superseded" || op.state === "succeeded") return;
      const state = error.needsReconnect
        ? "needs_reconnect"
        : error.retryable && op.attempt_count < 5
          ? "waiting_retry"
          : "failed";
      this.db.run(
        "UPDATE outbox_operations SET state=?,error_code=?,error_message=?,lease_until=NULL,next_attempt_at=?,updated_at=?,version=version+1 WHERE id=?",
        state,
        error.code,
        error.message.slice(0, 300),
        this.at() +
          Math.min(60000, 1000 * 2 ** Math.max(0, op.attempt_count - 1)),
        this.at(),
        id,
      );
      if (op.booking_id && state === "failed") {
        const b = this.one(
          "SELECT version FROM bookings WHERE id=?",
          op.booking_id,
        );
        if (b?.version === op.target_booking_version) {
          this.db.run(
            "UPDATE bookings SET sync_state='failed' WHERE id=?",
            op.booking_id,
          ); /* Keep the intent version stable: retry/Undo target this same accepted command. */
        }
      }
      if (error.needsReconnect)
        this.db.run(
          "UPDATE calendar_accounts SET status='needs_reconnect',updated_at=CASE WHEN status<>'needs_reconnect' THEN ? ELSE updated_at END,version=version+1 WHERE id=?",
          this.at(),
          op.account_id,
        );
    });
  }
  skipSetup(): void {
    this.internal("setup_skipped", () =>
      this.db.run("UPDATE settings SET setup_skipped=1 WHERE id=1"),
    );
  }
  /**
   * Earliest pending/retry instant that claimOperation would actually take.
   * An update held behind an earlier failed or reconnecting op on the same
   * booking is not due: waking for it spins the alarm without doing work.
   */
  earliestPendingAttempt(): number | null {
    const row = this.one(
      `SELECT MIN(op.next_attempt_at) AS next FROM outbox_operations op WHERE op.state IN ('pending','waiting_retry') AND NOT EXISTS (SELECT 1 FROM outbox_operations earlier WHERE earlier.booking_id=op.booking_id AND op.booking_id IS NOT NULL AND earlier.rowid<op.rowid AND earlier.state IN ${BLOCKING_OPERATION_STATES})`,
    );
    return row?.next == null ? null : Number(row.next);
  }
  hasConnectedCalendar(): boolean {
    return Boolean(
      this.one(
        "SELECT 1 AS ok FROM calendar_accounts WHERE status='connected' LIMIT 1",
      ),
    );
  }
  connectionsDueForSync(staleBefore: number): CalendarRole[] {
    return this.db
      .all(
        "SELECT role FROM calendar_accounts WHERE status='connected' AND (last_synced_at IS NULL OR last_synced_at<=?)",
        staleBefore,
      )
      .map((row) => row.role as CalendarRole);
  }
  /** Present bookings already observed on one calendar. Indexed by account + calendar. */
  presentBookingEventIds(accountId: string, calendarId: string): string[] {
    return this.db
      .all(
        "SELECT google_event_id FROM bookings WHERE account_id=? AND calendar_id=? AND desired_presence='present' AND (sync_state='synced' OR remote_start_utc IS NOT NULL)",
        accountId,
        calendarId,
      )
      .map((row) => String(row.google_event_id));
  }
  /** Default alarm window, or the caller's range normalized to UTC instants. */
  syncWindow(range?: { start: string; end: string }): {
    start: string;
    end: string;
  } {
    if (range)
      return {
        start: new Date(range.start).toISOString(),
        end: new Date(range.end).toISOString(),
      };
    const midnight = Date.parse(`${localParts(this.now()).date}T00:00:00Z`);
    return {
      start: new Date(midnight - CALENDAR_SYNC_PAST_MS).toISOString(),
      end: new Date(midnight + CALENDAR_SYNC_FUTURE_MS).toISOString(),
    };
  }
  /**
   * Deletes expired calendar-mirror and bookkeeping rows, sharing one row
   * budget across every table. Projects, books, tickets, learnings, reviews,
   * and bookings are never deleted. Failed, pending, running, waiting_retry,
   * and needs_reconnect outbox rows stay so Retry still works and later work
   * on that booking stays blocked.
   * `more` means the budget ran out with rows still eligible.
   */
  cleanupBookkeeping(limit = CLEANUP_DAILY_ROW_BUDGET): {
    more: boolean;
    deleted: number;
    tables: {
      calendar_events: number;
      outbox_operations: number;
      command_receipts: number;
      audit_log: number;
    };
  } {
    const tables = {
      calendar_events: 0,
      outbox_operations: 0,
      command_receipts: 0,
      audit_log: 0,
    };
    if (limit <= 0) return { more: true, deleted: 0, tables };
    const now = this.now();
    const past = now - CALENDAR_PAST_RETENTION_MS;
    const future = now + CALENDAR_FUTURE_RETENTION_MS;
    const pastDate = localParts(past).date;
    const futureDate = localParts(future).date;
    let remaining = limit;
    let deleted = 0;
    const statements: {
      table: keyof typeof tables;
      sql: string;
      probe: string;
      bindings: any[];
    }[] = [
      {
        table: "calendar_events",
        sql: "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE deleted_at IS NOT NULL LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM calendar_events WHERE deleted_at IS NOT NULL LIMIT 1",
        bindings: [],
      },
      {
        table: "calendar_events",
        sql: "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=0 AND end_utc<=? LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=0 AND end_utc<=? LIMIT 1",
        bindings: [past],
      },
      {
        table: "calendar_events",
        sql: "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=0 AND start_utc>=? LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=0 AND start_utc>=? LIMIT 1",
        bindings: [future],
      },
      {
        table: "calendar_events",
        sql: "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=1 AND end_date<=? LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=1 AND end_date<=? LIMIT 1",
        bindings: [pastDate],
      },
      {
        table: "calendar_events",
        sql: "DELETE FROM calendar_events WHERE rowid IN (SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=1 AND start_date>? LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM calendar_events WHERE deleted_at IS NULL AND all_day=1 AND start_date>? LIMIT 1",
        bindings: [futureDate],
      },
      {
        table: "outbox_operations",
        sql: "DELETE FROM outbox_operations WHERE rowid IN (SELECT rowid FROM outbox_operations WHERE state IN ('succeeded','superseded') AND updated_at<? LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM outbox_operations WHERE state IN ('succeeded','superseded') AND updated_at<? LIMIT 1",
        bindings: [now - OUTBOX_RETENTION_MS],
      },
      {
        table: "command_receipts",
        sql: "DELETE FROM command_receipts WHERE rowid IN (SELECT rowid FROM command_receipts WHERE committed_at<? LIMIT ?) RETURNING rowid",
        probe:
          "SELECT rowid FROM command_receipts WHERE committed_at<? LIMIT 1",
        bindings: [now - RECEIPT_RETENTION_MS],
      },
      {
        table: "audit_log",
        sql: "DELETE FROM audit_log WHERE rowid IN (SELECT rowid FROM audit_log WHERE occurred_at<? LIMIT ?) RETURNING rowid",
        probe: "SELECT rowid FROM audit_log WHERE occurred_at<? LIMIT 1",
        bindings: [now - AUDIT_RETENTION_MS],
      },
    ];
    const stillEligible = (probe: string, bindings: any[]) =>
      this.db.all(probe, ...bindings).length > 0;
    const snapshot = () => ({ more: true, deleted, tables: { ...tables } });
    for (const { table, sql, probe, bindings } of statements) {
      if (remaining <= 0) {
        if (stillEligible(probe, bindings)) return snapshot();
        continue;
      }
      while (remaining > 0) {
        const batch = Math.min(CLEANUP_BATCH_LIMIT, remaining);
        const removed = this.db.all(sql, ...bindings, batch);
        tables[table] += removed.length;
        deleted += removed.length;
        remaining -= removed.length;
        if (removed.length < batch) break;
        if (remaining === 0 && stillEligible(probe, bindings))
          return snapshot();
      }
    }
    return { more: false, deleted, tables };
  }
}
