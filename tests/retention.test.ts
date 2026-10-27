import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizerEngine, type DbPort } from "../src/domain/engine";
import {
  ALARM_ENSURE_INTERVAL_MS,
  ALARM_FAILURES_KEY,
  ALARM_HORIZON_MS,
  ALARM_RECOVERY_MAX_MS,
  ALARM_RECOVERY_MS,
  AUDIT_RETENTION_MS,
  CALENDAR_FUTURE_RETENTION_MS,
  CALENDAR_PAST_RETENTION_MS,
  CALENDAR_SYNC_INTERVAL_MS,
  CLEANUP_AT_KEY,
  CLEANUP_DAILY_ROW_BUDGET,
  CLEANUP_INTERVAL_MS,
  CLEANUP_PROGRESS_KEY,
  OUTBOX_RETENTION_MS,
  RECEIPT_RETENTION_MS,
} from "../src/domain/retention";
import { localParts } from "../src/domain/time";
import { ALL_SCOPES, type Actor } from "../src/shared/types";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
import { OrganizerStore } from "../src/storage/organizer";

const actor: Actor = { id: "owner", type: "human", scopes: ALL_SCOPES };
const databases: DatabaseSync[] = [];
const NOW = Date.parse("2026-10-18T16:00:00Z");
const NEW_INDEXES = [
  "events_active_end",
  "events_active_start",
  "events_active_end_date",
  "events_active_start_date",
  "events_tombstones",
  "events_account_span",
  "events_account_dates",
  "operations_terminal",
  "receipts_committed",
];

function fixture(at = NOW) {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  let time = at;
  const port: DbPort = {
    all(statement, ...bindings) {
      return sql.prepare(statement).all(...bindings) as any[];
    },
    run(statement, ...bindings) {
      sql.prepare(statement).run(...bindings);
    },
    transaction(callback) {
      sql.exec("BEGIN");
      try {
        const result = callback();
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const engine = new OrganizerEngine(port, { now: () => time });
  let sequence = 0;
  const apply = (tool: string, args: Record<string, unknown> = {}) =>
    engine.execute(
      tool,
      {
        idempotencyKey: `retention-${++sequence}`,
        expectedVersions: engine.snapshot().versions,
        ...args,
      },
      actor,
    ) as any;
  return {
    sql,
    port,
    engine,
    apply,
    setTime(next: number) {
      time = next;
    },
    count(table: string) {
      const row = sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      };
      return Number(row.n);
    },
  };
}

function storeFor(f: ReturnType<typeof fixture>) {
  const store = Object.create(OrganizerStore.prototype) as any;
  const kv = new Map<string, unknown>();
  const alarms: number[] = [];
  let deletedAlarm = 0;
  let currentAlarm: number | null = null;
  store.engine = f.engine;
  store.syncing = new Map();
  store.refreshing = new Map();
  store.ctx = {
    storage: {
      setAlarm: async (at: number) => {
        currentAlarm = at;
        alarms.push(at);
      },
      getAlarm: async () => currentAlarm,
      deleteAlarm: async () => {
        currentAlarm = null;
        deletedAlarm += 1;
      },
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
      },
    },
  };
  store.credentials = async () => ({
    accessToken: "test-token",
    refreshToken: "unused",
    expiresAt: Infinity,
  });
  return {
    store,
    kv,
    alarms,
    deletedAlarms: () => deletedAlarm,
  };
}

function bootingStore(
  f: ReturnType<typeof fixture>,
  initialAlarm: number | null,
) {
  const alarms: number[] = [];
  let current: number | null = initialAlarm;
  let startup: Promise<void> = Promise.resolve();
  const exec = (statement: string, ...bindings: unknown[]) => {
    const prepared = f.sql.prepare(statement);
    const rows = bindings.length
      ? prepared.all(...(bindings as never[]))
      : prepared.all();
    return { toArray: () => rows };
  };
  const ctx = {
    storage: {
      sql: { exec },
      transactionSync(callback: () => unknown) {
        f.sql.exec("BEGIN");
        try {
          const result = callback();
          f.sql.exec("COMMIT");
          return result;
        } catch (error) {
          f.sql.exec("ROLLBACK");
          throw error;
        }
      },
      getAlarm: async () => current,
      setAlarm: async (at: number) => {
        current = at;
        alarms.push(at);
      },
      deleteAlarm: async () => {
        current = null;
      },
      kv: { get: () => undefined, put: () => undefined },
    },
    blockConcurrencyWhile(callback: () => Promise<void>) {
      startup = callback();
    },
  };
  const store = new OrganizerStore(ctx as never, {} as never);
  return { store, alarms, startup, alarm: () => current };
}

function accountId(f: ReturnType<typeof fixture>) {
  const row = f.sql
    .prepare("SELECT id FROM calendar_accounts WHERE role='personal'")
    .get() as { id: string };
  return row.id;
}

function insertEvent(
  f: ReturnType<typeof fixture>,
  id: string,
  fields: {
    start?: number | null;
    end?: number | null;
    allDay?: boolean;
    startDate?: string | null;
    endDate?: string | null;
    deletedAt?: number | null;
  },
) {
  const allDay = fields.allDay ? 1 : 0;
  f.sql
    .prepare(
      `INSERT INTO calendar_events(account_id,calendar_id,google_event_id,title,start_utc,end_utc,all_day,start_date,end_date,is_busy,deleted_at,cached_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`,
    )
    .run(
      ...([
        accountId(f),
        "primary",
        id,
        id,
        allDay ? null : fields.start,
        allDay ? null : fields.end,
        allDay,
        fields.startDate ?? null,
        fields.endDate ?? null,
        fields.deletedAt ?? null,
        NOW,
      ] as any[]),
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const sql of databases.splice(0)) sql.close();
});

describe("bookkeeping retention", () => {
  it("deletes only expired mirror and bookkeeping rows", () => {
    const f = fixture();
    const project = f.apply("queue_project", {
      title: "Keep me",
      areaId: "tech",
    }).data.item;
    f.apply("start_item", { itemId: project.id });
    const book = f.apply("queue_book", {
      areaId: "self",
      source: { type: "manual", title: "Notes", authors: [], pageCount: 40 },
    }).data.item;
    const ticket = f.apply("create_ticket", {
      projectId: project.id,
      title: "Task",
    }).data.ticket;
    f.apply("add_learning", {
      text: "A real note",
      target: { kind: "project", id: project.id },
    });
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [],
    });
    const booking = f.apply("book_ticket", {
      ticketId: ticket.id,
      start: "2026-10-19T08:00:00+02:00",
      end: "2026-10-19T09:00:00+02:00",
      allowOverlap: true,
    }).data.booking;
    f.sql
      .prepare(
        "INSERT INTO reviews(id,review_date,draft_json,baseline_json,created_at,updated_at) VALUES('rev_old','2020-01-01','{}','{}',1,1)",
      )
      .run();
    f.sql
      .prepare(
        "INSERT INTO daily_dismissals(local_date,dismissed_at) VALUES('2020-01-02',1)",
      )
      .run();
    // Age the pending outbox row. In-flight work is not finished.
    f.sql
      .prepare(
        "UPDATE outbox_operations SET updated_at=?, created_at=? WHERE booking_id=?",
      )
      .run(1, 1, booking.id);

    const past = NOW - CALENDAR_PAST_RETENTION_MS;
    const future = NOW + CALENDAR_FUTURE_RETENTION_MS;
    const pastDate = localParts(past).date;
    insertEvent(f, "kept-recent", {
      start: past + 60_000,
      end: past + 3_600_000,
    });
    insertEvent(f, "drop-old", { start: past - 3_600_000, end: past });
    insertEvent(f, "kept-ahead", {
      start: future - 3_600_000,
      end: future - 60_000,
    });
    insertEvent(f, "drop-far", {
      start: future,
      end: future + 3_600_000,
    });
    insertEvent(f, "drop-tombstone", {
      start: NOW,
      end: NOW + 3_600_000,
      deletedAt: NOW,
    });
    insertEvent(f, "kept-all-day", {
      allDay: true,
      startDate: pastDate,
      endDate: "2026-10-19",
    });
    insertEvent(f, "drop-all-day", {
      allDay: true,
      startDate: "2020-01-01",
      endDate: pastDate,
    });

    const cutoff = NOW - OUTBOX_RETENTION_MS;
    const insertOp = (id: string, state: string, updated: number) =>
      f.sql
        .prepare(
          `INSERT INTO outbox_operations(id,actor_id,required_scope,account_id,action,payload_json,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'{}',?,?,?,?)`,
        )
        .run(
          id,
          "owner",
          "calendar:book",
          accountId(f),
          "sync",
          state,
          updated,
          updated,
          updated,
        );
    insertOp("op-keep-exact", "succeeded", cutoff);
    insertOp("op-drop-old", "succeeded", cutoff - 1);
    insertOp("op-keep-failed", "failed", cutoff - 1);
    insertOp("op-keep-running", "running", 1);
    insertOp("op-keep-pending", "pending", 1);
    insertOp("op-drop-superseded", "superseded", 1);
    insertOp("op-keep-reconnect", "needs_reconnect", 1);
    insertOp("op-keep-retry", "waiting_retry", 1);

    const receiptCutoff = NOW - RECEIPT_RETENTION_MS;
    const insertReceipt = (id: string, at: number) =>
      f.sql
        .prepare(
          "INSERT INTO command_receipts(id,actor_id,tool,idempotency_key,fingerprint,response_json,committed_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(id, "owner", "noop", id, "{}", "{}", at);
    insertReceipt("rcpt-keep", receiptCutoff);
    insertReceipt("rcpt-drop", receiptCutoff - 1);

    const auditCutoff = NOW - AUDIT_RETENTION_MS;
    const insertAudit = (id: string, at: number) =>
      f.sql
        .prepare(
          "INSERT INTO audit_log(id,actor_id,actor_type,action,entity_ids_json,summary,occurred_at) VALUES(?,?,'human',?,?,?,?)",
        )
        .run(id, "owner", "note", "[]", id, at);
    insertAudit("audit-keep", auditCutoff);
    insertAudit("audit-drop", auditCutoff - 1);

    const before = {
      projects: f.count("projects"),
      books: f.count("books"),
      tickets: f.count("tickets"),
      learnings: f.count("learnings"),
      reviews: f.count("reviews"),
      bookings: f.count("bookings"),
      dismissals: f.count("daily_dismissals"),
    };
    expect(f.engine.cleanupBookkeeping().more).toBe(false);
    expect({
      projects: f.count("projects"),
      books: f.count("books"),
      tickets: f.count("tickets"),
      learnings: f.count("learnings"),
      reviews: f.count("reviews"),
      bookings: f.count("bookings"),
      dismissals: f.count("daily_dismissals"),
    }).toEqual(before);
    expect(
      f.engine
        .snapshot()
        .items.map((item) => item.title)
        .sort(),
    ).toEqual(["Keep me", "Notes"]);
    expect(f.engine.snapshot().learnings.map((row) => row.text)).toEqual([
      "A real note",
    ]);
    expect(f.engine.snapshot().bookings).toHaveLength(1);

    const events = f.sql
      .prepare(
        "SELECT google_event_id FROM calendar_events ORDER BY google_event_id",
      )
      .all()
      .map((row) => row.google_event_id);
    expect(events).toEqual(["kept-ahead", "kept-all-day", "kept-recent"]);

    const ops = f.sql
      .prepare("SELECT id FROM outbox_operations ORDER BY id")
      .all()
      .map((row) => row.id);
    expect(ops).toEqual(
      expect.arrayContaining([
        "op-keep-exact",
        "op-keep-failed",
        "op-keep-running",
        "op-keep-pending",
        "op-keep-reconnect",
        "op-keep-retry",
      ]),
    );
    expect(ops).not.toEqual(
      expect.arrayContaining(["op-drop-old", "op-drop-superseded"]),
    );
    const pending = f.sql
      .prepare(
        "SELECT id FROM outbox_operations WHERE booking_id=? AND state='pending'",
      )
      .get(booking.id);
    expect(pending).toBeTruthy();

    expect(
      f.sql
        .prepare(
          "SELECT id FROM command_receipts WHERE id LIKE 'rcpt-%' ORDER BY id",
        )
        .all()
        .map((row) => row.id),
    ).toEqual(["rcpt-keep"]);
    expect(
      f.sql
        .prepare("SELECT id FROM audit_log WHERE id LIKE 'audit-%' ORDER BY id")
        .all()
        .map((row) => row.id),
    ).toEqual(["audit-keep"]);
  });

  it("shares one delete budget across tables and leaves the rest for later", () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const tombstones = 1500;
    const receipts = 1000;
    const insertEventRow = f.sql.prepare(
      "INSERT INTO calendar_events(account_id,calendar_id,google_event_id,title,start_utc,end_utc,all_day,is_busy,deleted_at,cached_at) VALUES(?,?,?,?,?,?,0,1,?,?)",
    );
    const id = accountId(f);
    for (let i = 0; i < tombstones; i++)
      insertEventRow.run(
        id,
        "primary",
        `tomb-${i}`,
        "gone",
        NOW,
        NOW + 60_000,
        NOW,
        NOW,
      );
    const insertReceipt = f.sql.prepare(
      "INSERT INTO command_receipts(id,actor_id,tool,idempotency_key,fingerprint,response_json,committed_at) VALUES(?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < receipts; i++)
      insertReceipt.run(
        `rcpt-${i}`,
        "owner",
        "noop",
        `rcpt-${i}`,
        "{}",
        "{}",
        1,
      );
    f.sql
      .prepare(
        "INSERT INTO audit_log(id,actor_id,actor_type,action,entity_ids_json,summary,occurred_at) VALUES(?,?,'human',?,?,?,?)",
      )
      .run("audit-later", "owner", "note", "[]", "later", 1);
    expect(f.engine.cleanupBookkeeping()).toMatchObject({
      more: true,
      deleted: CLEANUP_DAILY_ROW_BUDGET,
      tables: {
        calendar_events: tombstones,
        command_receipts: CLEANUP_DAILY_ROW_BUDGET - tombstones,
        outbox_operations: 0,
        audit_log: 0,
      },
    });
    expect(f.count("calendar_events")).toBe(0);
    expect(
      f.sql
        .prepare(
          "SELECT COUNT(*) AS n FROM command_receipts WHERE id LIKE 'rcpt-%'",
        )
        .get(),
    ).toEqual({ n: receipts - (CLEANUP_DAILY_ROW_BUDGET - tombstones) });
    expect(
      f.sql.prepare("SELECT id FROM audit_log WHERE id='audit-later'").get(),
    ).toEqual({ id: "audit-later" });
  });

  it("uses the tombstone and terminal-outbox indexes", () => {
    const f = fixture();
    const tombstone = JSON.stringify(
      f.sql
        .prepare(
          "EXPLAIN QUERY PLAN SELECT rowid FROM calendar_events WHERE deleted_at IS NOT NULL LIMIT 1",
        )
        .all(),
    );
    expect(tombstone).toContain("events_tombstones");
    const terminal = JSON.stringify(
      f.sql
        .prepare(
          "EXPLAIN QUERY PLAN SELECT rowid FROM outbox_operations WHERE state IN ('succeeded','superseded') AND updated_at < 1 LIMIT 1",
        )
        .all(),
    );
    expect(terminal).toContain("operations_terminal");
    const due = JSON.stringify(
      f.sql
        .prepare(
          "EXPLAIN QUERY PLAN SELECT MIN(op.next_attempt_at) AS next FROM outbox_operations op WHERE op.state IN ('pending','waiting_retry')",
        )
        .all(),
    );
    expect(due).toContain("operations_due");
    const replace = JSON.stringify(
      f.sql
        .prepare(
          "EXPLAIN QUERY PLAN SELECT rowid FROM calendar_events WHERE account_id=? AND calendar_id=? AND all_day=0 AND start_utc<? AND end_utc>?",
        )
        .all("account", "primary", 2, 1),
    );
    expect(replace).toContain("events_account_span");
  });

  it("adds the new indexes to an existing database without rewriting rows", () => {
    const f = fixture();
    const project = f.apply("queue_project", {
      title: "Already here",
      areaId: "tech",
    }).data.item;
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    insertEvent(f, "stored", { start: NOW, end: NOW + 3_600_000 });
    for (const name of NEW_INDEXES) f.sql.exec(`DROP INDEX IF EXISTS ${name}`);
    f.sql.prepare("DELETE FROM schema_versions WHERE version=3").run();
    expect(
      f.sql
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${NEW_INDEXES.map(() => "?").join(",")})`,
        )
        .all(...NEW_INDEXES),
    ).toEqual([]);

    const reopened = new OrganizerEngine(f.port, { now: () => NOW });
    expect(
      f.sql
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${NEW_INDEXES.map(() => "?").join(",")}) ORDER BY name`,
        )
        .all(...NEW_INDEXES)
        .map((row) => row.name),
    ).toEqual([...NEW_INDEXES].sort());
    expect(
      f.sql
        .prepare("SELECT version FROM schema_versions ORDER BY version")
        .all()
        .map((row) => row.version),
    ).toEqual([1, 2, 3]);
    expect(reopened.snapshot().items.map((item) => item.id)).toEqual([
      project.id,
    ]);
    expect(
      f.sql.prepare("SELECT google_event_id FROM calendar_events").all(),
    ).toEqual([{ google_event_id: "stored" }]);
    expect(f.sql.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

function failedCreateThenMove() {
  const f = fixture();
  const project = f.apply("queue_project", {
    title: "Keep me",
    areaId: "tech",
  }).data.item;
  f.apply("start_item", { itemId: project.id });
  const ticket = f.apply("create_ticket", {
    projectId: project.id,
    title: "Task",
  }).data.ticket;
  f.engine.connectAccount({
    role: "personal",
    email: "owner@example.test",
    encryptedCredentials: "encrypted",
  });
  f.engine.reconcileCalendar({
    role: "personal",
    calendarId: "primary",
    events: [],
  });
  const created = f.apply("book_ticket", {
    ticketId: ticket.id,
    start: "2026-10-19T08:00:00+02:00",
    end: "2026-10-19T09:00:00+02:00",
    allowOverlap: true,
  });
  const createId = created.data.effects.operationIds[0] as string;
  const booking = created.data.booking;
  expect(f.engine.claimOperation(createId)?.action).toBe("create");
  f.engine.failOperation(createId, {
    code: "PROVIDER_UNAVAILABLE",
    message: "create failed",
    retryable: false,
  });
  const moved = f.apply("move_booking", {
    bookingId: booking.id,
    start: "2026-10-19T10:00:00+02:00",
    end: "2026-10-19T11:00:00+02:00",
    allowOverlap: true,
  });
  const updateId = moved.data.effects.operationIds[0] as string;
  f.sql
    .prepare("UPDATE outbox_operations SET updated_at=? WHERE id=?")
    .run(NOW - OUTBOX_RETENTION_MS - 1, createId);
  f.sql
    .prepare(
      "INSERT INTO outbox_operations(id,actor_id,required_scope,account_id,action,payload_json,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'{}',?,?,?,?)",
    )
    .run(
      "op-drop-succeeded",
      "owner",
      "calendar:book",
      accountId(f),
      "sync",
      "succeeded",
      1,
      1,
      NOW - OUTBOX_RETENTION_MS - 1,
    );
  return { f, createId, updateId, booking };
}

describe("alarm read budget", () => {
  it("does not build a snapshot while refreshing a connected calendar", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    f.sql
      .prepare(
        "UPDATE calendar_accounts SET last_synced_at=0 WHERE role='personal'",
      )
      .run();
    const fetcher = vi.fn(async () =>
      Response.json({ items: [], nextSyncToken: "token" }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { store, alarms } = storeFor(f);
    const snapshot = vi.spyOn(f.engine, "snapshot");
    const started = Date.now();
    await store.alarm();
    expect(snapshot).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalled();
    const scheduled = alarms.at(-1)! - started;
    expect(scheduled).toBeGreaterThanOrEqual(CALENDAR_SYNC_INTERVAL_MS - 1000);
    expect(scheduled).toBeLessThanOrEqual(CALENDAR_SYNC_INTERVAL_MS + 1000);
    expect(scheduled).toBeGreaterThan(5 * 60 * 1000);
  });

  it("reschedules a bounded recovery alarm when storage reads fail", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const original = f.port.all.bind(f.port);
    f.port.all = () => {
      throw new Error("rows_read exceeded");
    };
    const { store, alarms } = storeFor(f);
    const snapshot = vi.spyOn(f.engine, "snapshot");
    const started = Date.now();
    await expect(store.alarm()).resolves.toBeUndefined();
    expect(snapshot).not.toHaveBeenCalled();
    const scheduled = alarms.at(-1)! - started;
    expect(scheduled).toBeGreaterThanOrEqual(ALARM_RECOVERY_MS - 1000);
    expect(scheduled).toBeLessThanOrEqual(ALARM_RECOVERY_MS + 1000);
    expect(scheduled).toBeGreaterThan(60_000);
    f.port.all = original;
  });

  it("purges on the alarm at most once per day and continues a backlog the next day", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const insertAudit = (id: string) =>
      f.sql
        .prepare(
          "INSERT INTO audit_log(id,actor_id,actor_type,action,entity_ids_json,summary,occurred_at) VALUES(?,?,'human',?,?,?,?)",
        )
        .run(id, "owner", "note", "[]", id, 1);
    insertAudit("old-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [] })),
    );
    const { store, kv } = storeFor(f);
    await store.alarm();
    expect(
      f.sql.prepare("SELECT id FROM audit_log WHERE id='old-1'").get(),
    ).toBeUndefined();
    insertAudit("old-2");
    await store.alarm();
    expect(
      f.sql.prepare("SELECT id FROM audit_log WHERE id='old-2'").get(),
    ).toBeTruthy();
    kv.set(CLEANUP_AT_KEY, Date.now() - CLEANUP_INTERVAL_MS - 1);
    await store.alarm();
    expect(
      f.sql.prepare("SELECT id FROM audit_log WHERE id='old-2'").get(),
    ).toBeUndefined();
  });

  it("keeps a failed create after purge so the queued move cannot patch an event that was never created", async () => {
    const { f, createId, updateId, booking } = failedCreateThenMove();
    expect(f.engine.cleanupBookkeeping().more).toBe(false);
    expect(
      f.sql
        .prepare("SELECT state FROM outbox_operations WHERE id=?")
        .get(createId),
    ).toEqual({ state: "failed" });
    expect(
      f.sql
        .prepare(
          "SELECT id FROM outbox_operations WHERE id='op-drop-succeeded'",
        )
        .get(),
    ).toBeUndefined();
    expect(f.engine.claimOperation(updateId)).toBeNull();
    expect(
      f.engine
        .snapshot()
        .operations.find((operation) => operation.id === createId)?.status,
    ).toBe("failed");
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: (init?.method ?? "GET").toUpperCase(),
        });
        return Response.json({ items: [], nextSyncToken: "token" });
      }),
    );
    const { store } = storeFor(f);
    await store.alarm();
    expect(
      calls.filter((call) => call.method === "POST" || call.method === "PATCH"),
    ).toEqual([]);
    expect(calls.some((call) => call.url.includes(booking.googleEventId))).toBe(
      false,
    );
    expect(f.engine.claimOperation(updateId)).toBeNull();
  });

  it("reports the purge finished when the budget ends on the last eligible row", () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const insert = f.sql.prepare(
      "INSERT INTO calendar_events(account_id,calendar_id,google_event_id,title,start_utc,end_utc,all_day,is_busy,deleted_at,cached_at) VALUES(?,?,?,?,?,?,0,1,?,?)",
    );
    const id = accountId(f);
    for (let i = 0; i < CLEANUP_DAILY_ROW_BUDGET; i++)
      insert.run(
        id,
        "primary",
        `tomb-${i}`,
        "gone",
        NOW,
        NOW + 60_000,
        NOW,
        NOW,
      );
    expect(f.engine.cleanupBookkeeping()).toMatchObject({
      more: false,
      deleted: CLEANUP_DAILY_ROW_BUDGET,
      tables: {
        calendar_events: CLEANUP_DAILY_ROW_BUDGET,
        outbox_operations: 0,
        command_receipts: 0,
        audit_log: 0,
      },
    });
    expect(f.count("calendar_events")).toBe(0);
  });

  it("does not re-arm inside the sync interval when the only due operation is held", async () => {
    const { f, updateId } = failedCreateThenMove();
    f.engine.cleanupBookkeeping();
    expect(f.engine.earliestPendingAttempt()).toBeNull();
    expect(f.engine.dueOperations().map((operation) => operation.id)).toContain(
      updateId,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextSyncToken: "token" })),
    );
    const { store, alarms } = storeFor(f);
    const started = Date.now();
    await store.alarm();
    await store.alarm();
    expect(alarms.length).toBeGreaterThan(0);
    for (const at of alarms) {
      const delay = at - started;
      expect(delay).toBeGreaterThanOrEqual(CALENDAR_SYNC_INTERVAL_MS - 1000);
      expect(delay).toBeGreaterThan(60_000);
    }
  });

  it("stops at the daily delete budget and continues the next day without marking cleanup finished", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const total = CLEANUP_DAILY_ROW_BUDGET + 3;
    const insert = f.sql.prepare(
      "INSERT INTO calendar_events(account_id,calendar_id,google_event_id,title,start_utc,end_utc,all_day,is_busy,deleted_at,cached_at) VALUES(?,?,?,?,?,?,0,1,?,?)",
    );
    const id = accountId(f);
    const start = NOW - 400 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < total; i++)
      insert.run(
        id,
        "primary",
        `tomb-${i}`,
        "gone",
        start,
        start + 60_000,
        NOW,
        NOW,
      );
    const tombstones = () =>
      Number(
        (
          f.sql
            .prepare(
              "SELECT COUNT(*) AS n FROM calendar_events WHERE deleted_at IS NOT NULL",
            )
            .get() as { n: number }
        ).n,
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextSyncToken: "token" })),
    );
    const { store, kv } = storeFor(f);
    await store.alarm();
    expect(tombstones()).toBe(3);
    expect(kv.get(CLEANUP_AT_KEY)).toBeUndefined();
    await store.alarm();
    expect(tombstones()).toBe(3);
    kv.set(CLEANUP_PROGRESS_KEY, {
      startedAt: Date.now() - CLEANUP_INTERVAL_MS - 1,
      deleted: CLEANUP_DAILY_ROW_BUDGET,
    });
    await store.alarm();
    expect(tombstones()).toBe(0);
    expect(kv.get(CLEANUP_AT_KEY)).toEqual(expect.any(Number));
  });

  it("keeps a booking alarm queued during an in-flight sync", async () => {
    const f = fixture();
    const project = f.apply("queue_project", {
      title: "Keep me",
      areaId: "tech",
    }).data.item;
    f.apply("start_item", { itemId: project.id });
    const ticket = f.apply("create_ticket", {
      projectId: project.id,
      title: "Task",
    }).data.ticket;
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    // Source freshness lets the booking skip its own sync. The account is still
    // due, so the alarm's fetch stays in flight while the booking is queued.
    // Pin the clock before 10:00 local so the slot stays in the future whenever
    // this file runs.
    const pinned = Date.parse("2026-10-27T08:00:00+01:00");
    const realNow = Date.now.bind(Date);
    const mark = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => pinned + (realNow() - mark));
    const { store, alarms, kv } = storeFor(f);
    kv.set(`calendar-profile:${accountId(f)}:primary`, {
      start: "2026-10-27T00:00:00.000Z",
      end: "2026-10-28T00:00:00.000Z",
    });
    f.sql
      .prepare("UPDATE calendar_sources SET last_synced_at=?")
      .run(Date.now());
    f.sql
      .prepare(
        "UPDATE calendar_accounts SET last_synced_at=0 WHERE role='personal'",
      )
      .run();
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) await gate;
        return Response.json({ items: [], nextSyncToken: "token" });
      }),
    );
    const running = store.alarm();
    await vi.waitFor(() => expect(calls).toBe(1));
    // The booking is queued after the alarm started, so its attempt time is later than alarmStartedAt.
    f.setTime(Date.now());
    const booked = await store.execute(
      "book_ticket",
      {
        ticketId: ticket.id,
        start: "2026-10-27T10:00:00+01:00",
        end: "2026-10-27T11:00:00+01:00",
        allowOverlap: true,
        idempotencyKey: "book-during-sync",
        expectedVersions: f.engine.snapshot().versions,
        acceptIncompleteAvailability: true,
      },
      actor,
    );
    expect(booked.error).toBeUndefined();
    const prompt = alarms.at(-1)!;
    const bookedAt = Date.now();
    expect(prompt).toBeLessThanOrEqual(bookedAt + 1000);
    expect(bookedAt - prompt).toBeLessThan(5_000);
    release();
    await running;
    expect(await store.ctx.storage.getAlarm()).toBe(prompt);
    expect(alarms.at(-1)).toBe(prompt);
    expect(prompt - bookedAt).toBeGreaterThan(-5_000);
    expect(Math.abs(prompt - bookedAt)).toBeLessThan(
      CALENDAR_SYNC_INTERVAL_MS / 2,
    );
  });

  it("arms a waiting retry that becomes due after the alarm started", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const due = Date.now() + 1000;
    f.sql
      .prepare(
        "INSERT INTO outbox_operations(id,actor_id,required_scope,account_id,action,payload_json,state,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,'{}','waiting_retry',?,?,?)",
      )
      .run(
        "op-retry-soon",
        "owner",
        "calendar:book",
        accountId(f),
        "sync",
        due,
        due,
        due,
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextSyncToken: "token" })),
    );
    const { store } = storeFor(f);
    await store.alarm();
    const alarmAt = await store.ctx.storage.getAlarm();
    expect(alarmAt).toBe(due);
    expect(alarmAt - Date.now()).toBeLessThan(5_000);
    expect(alarmAt - Date.now()).toBeGreaterThan(0);
  });

  it("re-arms a missing alarm on the first request without moving an earlier one later", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store, alarms } = storeFor(f);
    const started = Date.now();
    await store.snapshot();
    const armed = await store.ctx.storage.getAlarm();
    expect(armed).not.toBeNull();
    expect(armed! - started).toBeGreaterThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS - 1000,
    );
    expect(armed! - started).toBeLessThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS + 1000,
    );
    expect(alarms).toHaveLength(1);

    await store.snapshot();
    await store.ensureAlarm();
    expect(await store.ctx.storage.getAlarm()).toBe(armed);
    expect(alarms).toHaveLength(1);

    const sooner = Date.now() + 5_000;
    await store.ctx.storage.setAlarm(sooner);
    const scheduled = alarms.length;
    await store.snapshot();
    await store.execute(
      "queue_project",
      {
        title: "Keep the sooner alarm",
        areaId: "tech",
        idempotencyKey: "rearm-sooner",
        expectedVersions: f.engine.snapshot().versions,
      },
      actor,
    );
    expect(await store.ctx.storage.getAlarm()).toBe(sooner);
    expect(alarms).toHaveLength(scheduled);
    expect(alarms.at(-1)).toBe(sooner);
  });

  it("replaces an alarm more than a minute in the past", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store } = storeFor(f);
    const stale = Date.now() - ALARM_ENSURE_INTERVAL_MS - 1_000;
    await store.ctx.storage.setAlarm(stale);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const started = Date.now();
    await store.ensureAlarm();
    const armed = await store.ctx.storage.getAlarm();
    expect(armed).not.toBe(stale);
    expect(armed! - started).toBeGreaterThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS - 1000,
    );
    expect(armed! - started).toBeLessThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS + 1000,
    );
    const checks = logged.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("alarm_check"))
      .map(
        (line) =>
          JSON.parse(line) as { event: string; existing: number; now: number },
      );
    expect(checks).toEqual([
      expect.objectContaining({ event: "alarm_check", existing: stale }),
    ]);
    expect(checks[0].now).toEqual(expect.any(Number));
    logged.mockClear();
    await store.ensureAlarm();
    expect(await store.ctx.storage.getAlarm()).toBe(armed);
    expect(
      logged.mock.calls.some((call) => String(call[0]).includes("alarm_check")),
    ).toBe(false);
  });

  it("replaces an alarm further out than the schedule horizon", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store, alarms } = storeFor(f);
    const far = Date.now() + ALARM_HORIZON_MS + 60 * 60 * 1000;
    await store.ctx.storage.setAlarm(far);
    const started = Date.now();
    await store.ensureAlarm();
    const armed = await store.ctx.storage.getAlarm();
    expect(armed).not.toBe(far);
    expect(armed! - started).toBeGreaterThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS - 1000,
    );
    expect(armed! - started).toBeLessThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS + 1000,
    );
    expect(alarms.at(-1)).toBe(armed);
  });

  it("leaves a live future alarm where it is", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store, alarms } = storeFor(f);
    const live = Date.now() + 5 * 60 * 1000;
    await store.ctx.storage.setAlarm(live);
    const scheduled = alarms.length;
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await store.ensureAlarm();
    expect(await store.ctx.storage.getAlarm()).toBe(live);
    expect(alarms).toHaveLength(scheduled);
    const checks = logged.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("alarm_check"))
      .map((line) => JSON.parse(line));
    expect(checks).toEqual([
      expect.objectContaining({ event: "alarm_check", existing: live }),
    ]);
  });

  it("re-arms a missing alarm when the durable object starts", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const alarms: number[] = [];
    let current: number | null = null;
    let startup: Promise<void> = Promise.resolve();
    const exec = (statement: string, ...bindings: unknown[]) => {
      const prepared = f.sql.prepare(statement);
      const rows = bindings.length
        ? prepared.all(...(bindings as never[]))
        : prepared.all();
      return { toArray: () => rows };
    };
    const ctx = {
      storage: {
        sql: { exec },
        transactionSync(callback: () => unknown) {
          f.sql.exec("BEGIN");
          try {
            const result = callback();
            f.sql.exec("COMMIT");
            return result;
          } catch (error) {
            f.sql.exec("ROLLBACK");
            throw error;
          }
        },
        getAlarm: async () => current,
        setAlarm: async (at: number) => {
          current = at;
          alarms.push(at);
        },
        deleteAlarm: async () => {
          current = null;
        },
        kv: { get: () => undefined, put: () => undefined },
      },
      blockConcurrencyWhile(callback: () => Promise<void>) {
        startup = callback();
      },
    };
    new OrganizerStore(ctx as never, {} as never);
    await startup;
    expect(current).not.toBeNull();
    const delay = current! - Date.now();
    expect(delay).toBeGreaterThanOrEqual(CALENDAR_SYNC_INTERVAL_MS - 1000);
    expect(delay).toBeLessThanOrEqual(CALENDAR_SYNC_INTERVAL_MS + 1000);
    expect(alarms).toHaveLength(1);
  });

  it("schedules the next alarm when the handler hits the rows-read limit", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store, alarms, kv } = storeFor(f);
    f.port.all = () => {
      throw new Error(
        "Exceeded allowed rows read in Durable Objects free tier",
      );
    };
    const started = Date.now();
    await expect(store.alarm()).resolves.toBeUndefined();
    const scheduled = alarms.at(-1)! - started;
    expect(scheduled).toBeGreaterThanOrEqual(ALARM_RECOVERY_MS - 1000);
    expect(scheduled).toBeLessThanOrEqual(ALARM_RECOVERY_MS + 1000);
    expect(scheduled).toBeGreaterThan(60_000);
    expect(kv.get(ALARM_FAILURES_KEY)).toBe(1);
    expect(alarms).toHaveLength(1);
  });

  it("leaves an overdue alarm during startup and replaces it on a request", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const overdue = Date.now() - ALARM_ENSURE_INTERVAL_MS - 5_000;
    const booted = bootingStore(f, overdue);
    await booted.startup;
    expect(booted.alarm()).toBe(overdue);
    expect(booted.alarms).toEqual([]);
    const started = Date.now();
    await booted.store.ensureAlarm();
    const armed = booted.alarm();
    expect(armed).not.toBe(overdue);
    expect(armed! - started).toBeGreaterThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS - 1000,
    );
    expect(armed! - started).toBeLessThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS + 1000,
    );
  });

  it("replaces a far-future alarm during startup", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const far = Date.now() + ALARM_HORIZON_MS + 60 * 60 * 1000;
    const booted = bootingStore(f, far);
    await booted.startup;
    const armed = booted.alarm();
    expect(armed).not.toBe(far);
    expect(armed! - Date.now()).toBeGreaterThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS - 1000,
    );
    expect(armed! - Date.now()).toBeLessThanOrEqual(
      CALENDAR_SYNC_INTERVAL_MS + 1000,
    );
  });

  it("escalates the ensureAlarm recovery when arming throws", async () => {
    const f = fixture();
    f.port.all = () => {
      throw new Error("rows_read exceeded");
    };
    const { store, kv } = storeFor(f);
    const expected = [
      ALARM_RECOVERY_MS,
      ALARM_RECOVERY_MS * 2,
      ALARM_RECOVERY_MAX_MS,
    ];
    for (let attempt = 0; attempt < expected.length; attempt++) {
      await store.ctx.storage.deleteAlarm();
      const started = Date.now();
      await store.ensureAlarm();
      const delay = (await store.ctx.storage.getAlarm())! - started;
      expect(delay).toBeGreaterThanOrEqual(expected[attempt] - 1000);
      expect(delay).toBeLessThanOrEqual(expected[attempt] + 1000);
      expect(kv.get(ALARM_FAILURES_KEY)).toBe(attempt + 1);
    }
  });

  it("escalates from memory when the failure count cannot be read", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    f.port.all = () => {
      throw new Error("rows_read exceeded");
    };
    const { store, alarms, kv } = storeFor(f);
    const realGet = store.ctx.storage.kv.get.bind(store.ctx.storage.kv);
    const realPut = store.ctx.storage.kv.put.bind(store.ctx.storage.kv);
    store.ctx.storage.kv.get = (key: string) => {
      if (key === ALARM_FAILURES_KEY) throw new Error("rows_read exceeded");
      return realGet(key);
    };
    store.ctx.storage.kv.put = (key: string, value: unknown) => {
      if (key === ALARM_FAILURES_KEY) throw new Error("rows_read exceeded");
      return realPut(key, value);
    };
    const expected = [
      ALARM_RECOVERY_MS,
      ALARM_RECOVERY_MS * 2,
      ALARM_RECOVERY_MAX_MS,
    ];
    for (const delayMs of expected) {
      const before = alarms.length;
      const started = Date.now();
      await store.alarm();
      expect(alarms.length - before).toBe(1);
      const delay = alarms.at(-1)! - started;
      expect(delay).toBeGreaterThanOrEqual(delayMs - 1000);
      expect(delay).toBeLessThanOrEqual(delayMs + 1000);
    }
    expect(kv.get(ALARM_FAILURES_KEY)).toBeUndefined();
  });

  it("logs per-table cleanup counts", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    f.sql
      .prepare(
        "INSERT INTO audit_log(id,actor_id,actor_type,action,entity_ids_json,summary,occurred_at) VALUES(?,?,'human',?,?,?,?)",
      )
      .run("old-1", "owner", "note", "[]", "old-1", 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextSyncToken: "token" })),
    );
    const { store } = storeFor(f);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await store.alarm();
    const cleanups = logged.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"event":"cleanup"'))
      .map((line) => JSON.parse(line));
    expect(cleanups).toEqual([
      {
        event: "cleanup",
        more: false,
        deleted: {
          calendar_events: 0,
          outbox_operations: 0,
          command_receipts: 0,
          audit_log: 1,
        },
      },
    ]);
  });

  it("keeps a sooner alarm armed during a failed run", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store } = storeFor(f);
    let sooner = 0;
    f.port.all = () => {
      sooner = Date.now() + 2_000;
      void store.ctx.storage.setAlarm(sooner);
      throw new Error(
        "Exceeded allowed rows read in Durable Objects free tier",
      );
    };
    await expect(store.alarm()).resolves.toBeUndefined();
    expect(sooner).toBeGreaterThan(Date.now());
    expect(await store.ctx.storage.getAlarm()).toBe(sooner);
  });

  it("escalates consecutive alarm failures from 15 to 30 to 60 minutes and resets after success", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const original = f.port.all.bind(f.port);
    f.port.all = () => {
      throw new Error(
        "Exceeded allowed rows read in Durable Objects free tier",
      );
    };
    const { store, kv } = storeFor(f);
    const expected = [
      ALARM_RECOVERY_MS,
      ALARM_RECOVERY_MS * 2,
      ALARM_RECOVERY_MAX_MS,
      ALARM_RECOVERY_MAX_MS,
    ];
    for (let attempt = 0; attempt < expected.length; attempt++) {
      const started = Date.now();
      await expect(store.alarm()).resolves.toBeUndefined();
      const delay = (await store.ctx.storage.getAlarm())! - started;
      expect(delay).toBeGreaterThanOrEqual(expected[attempt] - 1000);
      expect(delay).toBeLessThanOrEqual(expected[attempt] + 1000);
      expect(kv.get(ALARM_FAILURES_KEY)).toBe(attempt + 1);
    }

    f.port.all = original;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [], nextSyncToken: "token" })),
    );
    await store.alarm();
    expect(kv.get(ALARM_FAILURES_KEY) ?? 0).toBe(0);

    f.port.all = () => {
      throw new Error(
        "Exceeded allowed rows read in Durable Objects free tier",
      );
    };
    const again = Date.now();
    await store.alarm();
    const reset = (await store.ctx.storage.getAlarm())! - again;
    expect(reset).toBeGreaterThanOrEqual(ALARM_RECOVERY_MS - 1000);
    expect(reset).toBeLessThanOrEqual(ALARM_RECOVERY_MS + 1000);
    expect(kv.get(ALARM_FAILURES_KEY)).toBe(1);
  });

  it("skips alarm writes when foreign keys cannot be enabled", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const { store, kv } = storeFor(f);
    store.schemaReady = true;
    store.ctx.storage.sql = {
      exec() {
        throw new Error(
          "Exceeded allowed rows read in Durable Objects free tier",
        );
      },
    };
    const cleanup = vi.spyOn(f.engine, "cleanupBookkeeping");
    const due = vi.spyOn(f.engine, "dueOperations");
    const started = Date.now();
    await expect(store.alarm()).resolves.toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(due).not.toHaveBeenCalled();
    const scheduled = (await store.ctx.storage.getAlarm())! - started;
    expect(scheduled).toBeGreaterThanOrEqual(ALARM_RECOVERY_MS - 1000);
    expect(scheduled).toBeLessThanOrEqual(ALARM_RECOVERY_MS + 1000);
    expect(kv.get(ALARM_FAILURES_KEY)).toBe(1);
  });

  it("does not tighten the backoff across repeated alarm failures or ensure calls", async () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    f.port.all = () => {
      throw new Error(
        "Exceeded allowed rows read in Durable Objects free tier",
      );
    };
    const { store, alarms } = storeFor(f);
    const started = Date.now();
    for (let attempt = 0; attempt < 4; attempt++)
      await expect(store.alarm()).resolves.toBeUndefined();
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms.length).toBeLessThanOrEqual(12);
    for (const at of alarms) {
      const delay = at - started;
      expect(delay).toBeGreaterThanOrEqual(ALARM_RECOVERY_MS - 1000);
      expect(delay).toBeLessThanOrEqual(ALARM_RECOVERY_MAX_MS + 1000);
    }
    const backedOff = await store.ctx.storage.getAlarm();
    expect(backedOff! - Date.now()).toBeGreaterThan(60_000);

    const quiet = fixture();
    const idle = storeFor(quiet);
    for (let n = 0; n < 20; n++) await idle.store.ensureAlarm();
    expect(idle.alarms).toEqual([]);
    expect(idle.deletedAlarms()).toBe(0);
    expect(await idle.store.ctx.storage.getAlarm()).toBeNull();

    await store.ensureAlarm();
    expect(await store.ctx.storage.getAlarm()).toBe(backedOff);
    expect(alarms.at(-1)).toBe(backedOff);
  });
});
