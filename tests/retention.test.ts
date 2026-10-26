import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizerEngine, type DbPort } from "../src/domain/engine";
import {
  ALARM_RECOVERY_MS,
  AUDIT_RETENTION_MS,
  CALENDAR_FUTURE_RETENTION_MS,
  CALENDAR_PAST_RETENTION_MS,
  CALENDAR_SYNC_INTERVAL_MS,
  CLEANUP_AT_KEY,
  CLEANUP_BATCH_LIMIT,
  CLEANUP_INTERVAL_MS,
  CLEANUP_MAX_BATCHES,
  OUTBOX_RETENTION_MS,
  RECEIPT_RETENTION_MS,
} from "../src/domain/retention";
import { localParts } from "../src/domain/time";
import { ALL_SCOPES, type Actor } from "../src/shared/types";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
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
  store.engine = f.engine;
  store.syncing = new Map();
  store.refreshing = new Map();
  store.ctx = {
    storage: {
      setAlarm: async (at: number) => {
        alarms.push(at);
      },
      deleteAlarm: async () => {
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
    insertOp("op-drop-failed", "failed", cutoff - 1);
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
    expect(f.engine.cleanupBookkeeping()).toBe(false);
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
        "op-keep-reconnect",
        "op-keep-retry",
      ]),
    );
    expect(ops).not.toEqual(
      expect.arrayContaining([
        "op-drop-old",
        "op-drop-failed",
        "op-drop-superseded",
      ]),
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

  it("stops a single pass at the batch cap and reports that more rows remain", () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted",
    });
    const total = CLEANUP_MAX_BATCHES * CLEANUP_BATCH_LIMIT + 1;
    const insert = f.sql.prepare(
      "INSERT INTO calendar_events(account_id,calendar_id,google_event_id,title,start_utc,end_utc,all_day,is_busy,deleted_at,cached_at) VALUES(?,?,?,?,?,?,0,1,?,?)",
    );
    const id = accountId(f);
    for (let i = 0; i < total; i++)
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
    expect(f.engine.cleanupBookkeeping()).toBe(true);
    expect(f.count("calendar_events")).toBe(1);
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
          "EXPLAIN QUERY PLAN SELECT rowid FROM outbox_operations WHERE state IN ('succeeded','failed','superseded') AND updated_at < 1 LIMIT 1",
        )
        .all(),
    );
    expect(terminal).toContain("operations_terminal");
    const due = JSON.stringify(
      f.sql
        .prepare(
          "EXPLAIN QUERY PLAN SELECT MIN(next_attempt_at) AS next FROM outbox_operations WHERE state IN ('pending','waiting_retry')",
        )
        .all(),
    );
    expect(due).toContain("operations_due");
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
});
