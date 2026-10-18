import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizerEngine, type DbPort } from "../src/domain/engine";
import { ALL_SCOPES, type Actor } from "../src/shared/types";
import { dayBounds, localParts, reviewDate } from "../src/domain/time";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { OrganizerStore } from "../src/storage/organizer";

const actor: Actor = { id: "owner", type: "human", scopes: ALL_SCOPES };
const databases: DatabaseSync[] = [];
function fixture(at = "2026-10-18T16:00:00Z") {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec("PRAGMA foreign_keys=ON");
  let time = Date.parse(at);
  let failNextStart = false;
  const port: DbPort = {
    all(statement, ...bindings) {
      return sql.prepare(statement).all(...bindings);
    },
    run(statement, ...bindings) {
      if (failNextStart && statement.includes("SET state='active'")) {
        failNextStart = false;
        throw new Error("Injected storage failure");
      }
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
        idempotencyKey: `test-${++sequence}`,
        expectedVersions: {
          ...engine.snapshot().versions,
          [`review:${engine.snapshot().reviewDate}`]:
            engine.snapshot().versions[
              `review:${engine.snapshot().reviewDate}`
            ] ?? "0",
        },
        ...args,
      },
      actor,
    ) as any;
  const project = (title = "Project", areaId = "tech") =>
    apply("queue_project", { title, areaId }).data.item;
  const active = (title = "Project") => {
    const item = project(title);
    apply("start_item", { itemId: item.id });
    return engine.snapshot().items.find((i) => i.id === item.id)!;
  };
  const calendar = () => {
    engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      encryptedCredentials: "encrypted-token",
    });
    engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [],
    });
  };
  return {
    sql,
    port,
    engine,
    apply,
    project,
    active,
    calendar,
    setTime: (v: string) => {
      time = Date.parse(v);
    },
    injectFailure: () => {
      failNextStart = true;
    },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function storeFor(engine: OrganizerEngine) {
  const store = Object.create(OrganizerStore.prototype) as any,
    kv = new Map();
  store.engine = engine;
  store.syncing = new Map();
  store.refreshing = new Map();
  store.ctx = {
    storage: {
      setAlarm: async () => {},
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
      },
    },
  };
  store.env = {};
  store.credentials = async () => ({
    accessToken: "test-token",
    refreshToken: "unused",
    expiresAt: Infinity,
  });
  return store;
}

describe("persisted Organizer domain", () => {
  it("seeds only fixed areas and preserves real content across engine restarts", () => {
    const f = fixture();
    expect(f.engine.snapshot().areas).toHaveLength(4);
    expect(f.engine.snapshot().items).toEqual([]);
    const p = f.project();
    const reopened = new OrganizerEngine(f.port);
    expect(reopened.snapshot().items[0].id).toBe(p.id);
  });

  it("enforces place occupancy in commands and the actual SQLite partial index", () => {
    const f = fixture();
    const first = f.active();
    const next = f.project("Next");
    expect(() => f.apply("start_item", { itemId: next.id })).toThrow(
      "already reserved",
    );
    expect(() =>
      f.sql
        .prepare("UPDATE projects SET state='active' WHERE id=?")
        .run(next.id),
    ).toThrow(/UNIQUE/);
    expect(
      f.engine.snapshot().items.find((i) => i.id === first.id)?.state,
    ).toBe("active");
  });

  it("rolls back the whole swap when storage fails after vacating the holder", () => {
    const f = fixture();
    const current = f.active();
    const ticket = f.apply("create_ticket", {
      projectId: current.id,
      title: "Work",
    }).data.ticket;
    f.apply("set_ticket_status", {
      ticketId: ticket.id,
      status: "in_progress",
    });
    const next = f.project("Next");
    const before = f.engine.snapshot();
    f.injectFailure();
    expect(() =>
      f.apply("replace_active_item", {
        currentItemId: current.id,
        nextItemId: next.id,
        disposition: "pause",
      }),
    ).toThrow("Injected");
    expect(f.engine.snapshot()).toEqual(before);
    f.apply("replace_active_item", {
      currentItemId: current.id,
      nextItemId: next.id,
      disposition: "pause",
    });
    expect(
      f.engine.snapshot().items.find((i) => i.id === current.id)?.state,
    ).toBe("paused");
    expect(f.engine.snapshot().items.find((i) => i.id === next.id)?.state).toBe(
      "active",
    );
    expect(f.engine.snapshot().tickets[0].status).toBe("todo");
  });

  it("rejects stale writes but replays the original idempotent result before revision checks", () => {
    const f = fixture();
    const p = f.project();
    const args = {
      projectId: p.id,
      patch: { title: "Updated" },
      expectedVersions: f.engine.snapshot().versions,
      idempotencyKey: "same",
    };
    const first = f.engine.execute("update_project", args, actor) as any;
    const replay = f.engine.execute("update_project", args, actor) as any;
    expect(replay.data.deduplicated).toBe(true);
    expect(replay.data.item.id).toBe(first.data.item.id);
    expect(() =>
      f.engine.execute(
        "update_project",
        { ...args, idempotencyKey: "new" },
        actor,
      ),
    ).toThrow("current state");
    expect(() =>
      f.engine.execute(
        "update_project",
        { ...args, patch: { title: "Different" } },
        actor,
      ),
    ).toThrow("different arguments");
  });

  it("previews real compound effects without persisting rows or a receipt", () => {
    const f = fixture();
    const p = f.project();
    const before = f.engine.snapshot();
    const result = f.engine.execute(
      "start_item",
      { itemId: p.id, mode: "preview" },
      actor,
    ) as any;
    expect(result.data.outcome).toBe("preview");
    expect(result.data.requiredVersions[`item:${p.id}`]).toBe(p.version);
    expect(f.engine.snapshot()).toEqual(before);
    expect(
      f.sql.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()!.n,
    ).toBe(1);
  });

  it("locks queued work while allowing metadata, and preserves closed versus done", () => {
    const f = fixture();
    const p = f.project();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    expect(() =>
      f.apply("set_ticket_status", { ticketId: t.id, status: "in_progress" }),
    ).toThrow("Start or resume");
    f.apply("update_ticket", { ticketId: t.id, title: "Prepared task" });
    f.apply("start_item", { itemId: p.id });
    f.apply("finish_item", { itemId: p.id });
    expect(f.engine.snapshot().tickets[0].status).toBe("closed");
    expect(f.engine.snapshot().tickets[0].doneAt).toBeUndefined();
    expect(() =>
      f.apply("create_ticket", { projectId: p.id, title: "Too late" }),
    ).toThrow("read-only");
  });

  it("retains ended booking occurrences and stable provider identity across retries", () => {
    const f = fixture("2026-10-19T05:00:00Z");
    f.calendar();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    const first = f.apply("book_ticket", {
      ticketId: t.id,
      start: "2026-10-19T08:00:00+02:00",
      end: "2026-10-19T09:00:00+02:00",
      allowOverlap: false,
    }).data.booking;
    const op = f.engine.dueOperations()[0];
    f.engine.claimOperation(op.id);
    f.engine.failOperation(op.id, {
      code: "TIMEOUT",
      message: "Unknown remote outcome",
      retryable: true,
    });
    f.setTime("2026-10-19T05:00:02Z");
    const claimed = f.engine.claimOperation(op.id)!;
    expect(claimed.booking?.googleEventId).toBe(first.googleEventId);
    f.engine.completeOperation(op.id, {
      remoteEvent: { start: first.start, end: first.end, etag: "v1" },
    });
    f.setTime("2026-10-19T08:00:00Z");
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [],
    });
    const next = f.apply("book_ticket", {
      ticketId: t.id,
      start: "2026-10-20T08:00:00+02:00",
      end: "2026-10-20T09:00:00+02:00",
      allowOverlap: false,
    }).data.booking;
    expect(next.id).not.toBe(first.id);
    expect(next.googleEventId).not.toBe(first.googleEventId);
    expect(f.engine.snapshot().bookings).toHaveLength(2);
    expect(
      f.engine.snapshot().bookings.find((b) => b.id === first.id)?.retiredAt,
    ).toBeDefined();
    expect(() => f.apply("remove_booking", { bookingId: first.id })).toThrow(
      "current upcoming",
    );
  });

  it("records cancellation of an ambiguous create until Google absence is confirmed", () => {
    const f = fixture();
    f.calendar();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    const result = f.apply("book_ticket", {
      ticketId: t.id,
      start: "2026-10-19T08:00:00+02:00",
      end: "2026-10-19T09:00:00+02:00",
      allowOverlap: false,
    });
    const create = result.data.effects.operationIds[0];
    f.engine.claimOperation(create);
    f.engine.failOperation(create, {
      code: "TIMEOUT",
      message: "Unknown remote outcome",
    });
    f.apply("undo_booking_change", { operationId: create });
    const s = f.engine.snapshot();
    expect(s.tickets[0].currentBookingId).toBeUndefined();
    expect(s.bookings[0].desiredPresence).toBe("absent");
    const deletion = s.operations.find((o) => o.action === "delete")!;
    expect(deletion.status).toBe("pending");
    expect(s.bookings[0].syncState).toBe("pending");
    f.engine.claimOperation(deletion.id);
    f.engine.completeOperation(deletion.id);
    expect(f.engine.snapshot().bookings[0].syncState).toBe("synced");
  });

  it("keeps review drafts effect-free then saves exactly once, with no duplicate learning on replay", () => {
    const f = fixture();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    f.apply("set_ticket_day", { ticketId: t.id, plannedFor: "2026-10-18" });
    f.apply("update_review_draft", {
      date: "2026-10-18",
      patch: {
        completedTicketIds: [t.id],
        slippedDestinations: [],
        learning: {
          text: "A useful finding.",
          target: { kind: "project", id: p.id },
        },
      },
    });
    expect(f.engine.snapshot().tickets[0].status).toBe("todo");
    expect(f.engine.snapshot().learnings).toHaveLength(0);
    expect(f.engine.snapshot().operations).toHaveLength(0);
    const args = {
      date: "2026-10-18",
      idempotencyKey: "save-once",
      expectedVersions: f.engine.snapshot().versions,
    };
    f.engine.execute("save_review", args, actor);
    expect(f.engine.snapshot().tickets[0].status).toBe("done");
    expect(f.engine.snapshot().learnings).toHaveLength(1);
    expect(
      (f.engine.execute("save_review", args, actor) as any).data.deduplicated,
    ).toBe(true);
    expect(f.engine.snapshot().learnings).toHaveLength(1);
    expect(() => f.apply("save_review", { date: "2026-10-18" })).toThrow(
      "final",
    );
    expect(() =>
      f.apply("update_review_draft", {
        date: "2026-10-18",
        patch: { learning: null },
      }),
    ).toThrow("final");
  });

  it("protects stale drafts from overwriting later agent edits", () => {
    const f = fixture();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    f.apply("set_ticket_day", { ticketId: t.id, plannedFor: "2026-10-18" });
    f.apply("update_review_draft", {
      date: "2026-10-18",
      patch: { completedTicketIds: [t.id] },
    });
    f.apply("update_ticket", { ticketId: t.id, title: "Changed elsewhere" });
    expect(() => f.apply("save_review", { date: "2026-10-18" })).toThrow(
      "stale",
    );
    expect(f.engine.snapshot().reviews[0].savedAt).toBeUndefined();
    expect(f.engine.snapshot().tickets[0].status).toBe("todo");
  });

  it("allows multiple direct learnings with server dates and verifies active parents", () => {
    const f = fixture("2026-10-18T23:00:00Z");
    const p = f.active();
    f.apply("add_learning", {
      text: "First",
      target: { kind: "project", id: p.id },
    });
    f.apply("add_learning", {
      text: "Second",
      target: { kind: "project", id: p.id },
    });
    expect(f.engine.snapshot().reviewDate).toBe("2026-10-18");
    expect(f.engine.snapshot().learnings.map((l) => l.createdOn)).toEqual([
      "2026-10-19",
      "2026-10-19",
    ]);
    expect(
      f.engine.snapshot().learnings.every((l) => l.createdBy === actor.id),
    ).toBe(true);
    f.apply("pause_item", { itemId: p.id });
    expect(() =>
      f.apply("add_learning", {
        text: "No",
        target: { kind: "project", id: p.id },
      }),
    ).toThrow("Start or resume");
    expect(() =>
      f.sql
        .prepare(
          "INSERT INTO learnings(id,text,created_on,source_kind,project_id,book_id,created_by_actor_id,created_at) VALUES('bad','text','2026-10-19','direct',NULL,NULL,'owner',1)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it("rejects work calendar writes and redacts external titles without details scope", () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "work",
      email: "work@example.test",
      encryptedCredentials: "secret",
      writeCalendarId: "forbidden",
    });
    expect(f.engine.snapshot().connections[0].writeCalendarId).toBeUndefined();
    f.engine.reconcileCalendar({
      role: "work",
      calendarId: "primary",
      events: [
        {
          id: "external",
          title: "Secret meeting",
          start: "2026-10-19T08:00:00Z",
          end: "2026-10-19T09:00:00Z",
        },
      ],
    });
    const reader: Actor = {
      id: "reader",
      type: "agent",
      scopes: ["organizer:read", "calendar:busy:read"],
    };
    const result = f.engine.execute(
      "list_calendar_events",
      { start: "2026-10-19T00:00:00Z", end: "2026-10-20T00:00:00Z" },
      reader,
    ) as any;
    expect(result.data.items[0].title).toBe("Busy");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(() =>
      f.engine.execute(
        "list_calendar_events",
        {
          start: "2026-10-19T00:00:00Z",
          end: "2026-10-20T00:00:00Z",
          detail: "titles",
        },
        reader,
      ),
    ).toThrow("scope");
  });

  it("handles local review cutoff and non-24-hour DST days", () => {
    expect(reviewDate(Date.parse("2026-10-19T01:59:00Z"))).toBe("2026-10-18");
    expect(reviewDate(Date.parse("2026-10-19T02:00:00Z"))).toBe("2026-10-19");
    const [start, end] = dayBounds("2026-10-25");
    expect(end - start).toBe(25 * 3600000);
    expect(localParts(start).date).toBe("2026-10-25");
  });

  it("orders an unacknowledged create before its later move and rename", () => {
    const f = fixture();
    f.calendar();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Initial" })
      .data.ticket;
    const created = f.apply("book_ticket", {
      ticketId: t.id,
      start: "2026-10-19T08:00:00+02:00",
      end: "2026-10-19T09:00:00+02:00",
      allowOverlap: false,
    });
    const createId = created.data.effects.operationIds[0],
      b = created.data.booking;
    const moved = f.apply("move_booking", {
      bookingId: b.id,
      start: "2026-10-19T10:00:00+02:00",
      end: "2026-10-19T11:00:00+02:00",
      allowOverlap: false,
    });
    const moveId = moved.data.effects.operationIds[0];
    f.apply("update_ticket", { ticketId: t.id, title: "Renamed" });
    expect(
      f.engine.snapshot().operations.find((o) => o.id === createId)?.status,
    ).toBe("pending");
    expect(f.engine.claimOperation(moveId)).toBeNull();
    expect(f.engine.claimOperation(createId)?.action).toBe("create");
    f.engine.completeOperation(createId, {
      remoteEvent: { start: b.start, end: b.end, etag: "v1" },
    });
    expect(f.engine.claimOperation(moveId)?.action).toBe("update");
    f.engine.completeOperation(moveId, {
      remoteEvent: {
        start: moved.data.booking.start,
        end: moved.data.booking.end,
        etag: "v2",
      },
    });
    const rename = f.engine.dueOperations()[0];
    expect(f.engine.claimOperation(rename.id)?.payload.summary).toBe("Renamed");
  });

  it("requeues cancelled intent if a timed-out create appears after deletion succeeded", () => {
    const f = fixture();
    f.calendar();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    const b = f.apply("book_ticket", {
      ticketId: t.id,
      start: "2026-10-19T08:00:00+02:00",
      end: "2026-10-19T09:00:00+02:00",
      allowOverlap: false,
    }).data.booking;
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [
        {
          id: b.googleEventId,
          title: "Task",
          start: b.start,
          end: b.end,
          etag: "v1",
        },
      ],
    });
    const removed = f.apply("remove_booking", { bookingId: b.id });
    const deletion = removed.data.effects.operationIds[0];
    f.engine.claimOperation(deletion);
    f.engine.completeOperation(deletion);
    expect(f.engine.snapshot().events).toHaveLength(0);
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [
        {
          id: b.googleEventId,
          title: "Task",
          start: b.start,
          end: b.end,
          etag: "late",
        },
      ],
    });
    const cleanup = f.engine
      .snapshot()
      .operations.filter(
        (o) => o.action === "delete" && o.status === "pending",
      );
    expect(cleanup).toHaveLength(1);
    expect(f.engine.snapshot().bookings[0].desiredPresence).toBe("absent");
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [
        {
          id: b.googleEventId,
          title: "Task",
          start: b.start,
          end: b.end,
          etag: "late",
        },
      ],
    });
    expect(
      f.engine
        .snapshot()
        .operations.filter(
          (o) => o.action === "delete" && o.status === "pending",
        ),
    ).toHaveLength(1);
  });

  it("adopts independent Google moves/deletes and does not advance booking versions on unchanged polls", () => {
    const f = fixture();
    f.calendar();
    const p = f.active();
    const t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
      .ticket;
    const result = f.apply("book_ticket", {
        ticketId: t.id,
        start: "2026-10-19T08:00:00+02:00",
        end: "2026-10-19T09:00:00+02:00",
        allowOverlap: false,
      }),
      b = result.data.booking;
    const op = result.data.effects.operationIds[0];
    f.engine.claimOperation(op);
    f.engine.completeOperation(op, {
      remoteEvent: { start: b.start, end: b.end, etag: "v1" },
    });
    const moved = {
      id: b.googleEventId,
      start: "2026-10-19T08:17:00Z",
      end: "2026-10-19T09:23:00Z",
      etag: "v2",
    };
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [moved],
    });
    expect(Date.parse(f.engine.snapshot().bookings[0].start)).toBe(
      Date.parse(moved.start),
    );
    const version = f.engine.snapshot().bookings[0].version;
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [moved],
    });
    expect(f.engine.snapshot().bookings[0].version).toBe(version);
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [{ id: b.googleEventId, deleted: true }],
    });
    expect(f.engine.snapshot().tickets[0].currentBookingId).toBeUndefined();
  });

  it("validates books, clamps page corrections, and keeps final reviews immutable in SQLite", () => {
    const f = fixture();
    const b = f.apply("queue_book", {
      areaId: "self",
      source: {
        type: "manual",
        title: "Book",
        authors: ["Author"],
        pageCount: 100,
      },
    }).data.item;
    f.apply("start_item", { itemId: b.id });
    f.apply("set_book_progress", { bookId: b.id, currentPage: 80 });
    f.apply("update_book", { bookId: b.id, patch: { pageCount: 50 } });
    expect(f.engine.snapshot().items[0].currentPage).toBe(50);
    expect(f.engine.snapshot().items[0].state).toBe("active");
    f.apply("update_review_draft", {
      date: "2026-10-18",
      patch: {
        markReadBookIds: [b.id],
        learning: {
          text: "Learned from this book.",
          target: { kind: "book", id: b.id },
        },
      },
    });
    f.apply("save_review", { date: "2026-10-18" });
    expect(f.engine.snapshot().items[0].state).toBe("done");
    expect(f.engine.snapshot().learnings[0].bookId).toBe(b.id);
    expect(() =>
      f.sql
        .prepare(
          "UPDATE reviews SET saved_json='{}' WHERE review_date='2026-10-18'",
        )
        .run(),
    ).toThrow("final");
  });

  it("fits free starts to requested length and guards overlap/bounds", () => {
    const f = fixture();
    f.calendar();
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [
        {
          id: "busy",
          start: "2026-10-19T07:30:00+02:00",
          end: "2026-10-19T08:00:00+02:00",
        },
      ],
    });
    const starts = f.engine.execute(
      "find_free_starts",
      { date: "2026-10-19", lengthMinutes: 60 },
      actor,
    ) as any;
    expect(starts.data.starts[0]).toBe("2026-10-19T06:00:00.000Z");
    const p = f.active(),
      t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
        .ticket;
    expect(() =>
      f.apply("book_ticket", {
        ticketId: t.id,
        start: "2026-10-19T07:00:00+02:00",
        end: "2026-10-19T08:00:00+02:00",
        allowOverlap: false,
      }),
    ).toThrow("overlaps");
    expect(() =>
      f.apply("book_ticket", {
        ticketId: t.id,
        start: "2026-10-19T22:30:00+02:00",
        end: "2026-10-20T00:00:00+02:00",
        allowOverlap: true,
      }),
    ).toThrow("one local day");
    f.apply("book_ticket", {
      ticketId: t.id,
      start: "2026-10-19T07:00:00+02:00",
      end: "2026-10-19T08:00:00+02:00",
      allowOverlap: true,
    });
  });

  it("adopts the provider interval from an ambiguous create retry without overwriting newer local intent", () => {
    const f = fixture();
    f.calendar();
    const p = f.active(),
      t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
        .ticket;
    const created = f.apply("book_ticket", {
        ticketId: t.id,
        start: "2026-10-19T08:00:00+02:00",
        end: "2026-10-19T09:00:00+02:00",
        allowOverlap: false,
      }),
      b = created.data.booking;
    const createId = created.data.effects.operationIds[0];
    f.engine.claimOperation(createId);
    f.engine.completeOperation(createId, {
      remoteEvent: {
        start: "2026-10-19T11:07:00+02:00",
        end: "2026-10-19T12:23:00+02:00",
        etag: "google-moved",
      },
    });
    expect(f.engine.snapshot().bookings[0].start).toBe(
      "2026-10-19T09:07:00.000Z",
    );
    expect(f.engine.snapshot().bookings[0].syncState).toBe("synced");
    const moved = f.apply("move_booking", {
      bookingId: b.id,
      start: "2026-10-19T14:00:00+02:00",
      end: "2026-10-19T15:00:00+02:00",
      allowOverlap: false,
    });
    // A late repeated acknowledgment of the older create must not replace the queued move.
    f.engine.completeOperation(createId, {
      remoteEvent: {
        start: "2026-10-19T11:07:00+02:00",
        end: "2026-10-19T12:23:00+02:00",
        etag: "google-moved",
      },
    });
    expect(f.engine.snapshot().bookings[0].start).toBe(
      moved.data.booking.start,
    );
    expect(f.engine.snapshot().bookings[0].syncState).toBe("pending");
  });

  it.each([404, 410])(
    "reconciles PATCH %s for an observed booking without recreating it",
    async (status) => {
      const f = fixture();
      f.calendar();
      const p = f.active(),
        t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
          .ticket;
      const created = f.apply("book_ticket", {
          ticketId: t.id,
          start: "2026-10-19T08:00:00+02:00",
          end: "2026-10-19T09:00:00+02:00",
          allowOverlap: false,
        }),
        b = created.data.booking;
      const createId = created.data.effects.operationIds[0];
      f.engine.claimOperation(createId);
      f.engine.completeOperation(createId, {
        remoteEvent: { start: b.start, end: b.end, etag: "observed" },
      });
      const moved = f.apply("move_booking", {
        bookingId: b.id,
        start: "2026-10-19T10:00:00+02:00",
        end: "2026-10-19T11:00:00+02:00",
        allowOverlap: false,
      });
      const fetcher = vi.fn(async (_url, init) => {
        expect(init.method).toBe("PATCH");
        return Response.json(
          { error: { errors: [{ reason: "notFound" }] } },
          { status },
        );
      });
      vi.stubGlobal("fetch", fetcher);
      const store = Object.create(OrganizerStore.prototype) as any;
      store.engine = f.engine;
      store.ctx = { storage: { setAlarm: async () => {} } };
      store.env = {};
      store.credentials = async () => ({
        accessToken: "test-token",
        refreshToken: "unused",
        expiresAt: Infinity,
      });
      store.synchronize = async () => {};
      await store.alarm();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(f.engine.snapshot().tickets[0].currentBookingId).toBeUndefined();
      expect(f.engine.snapshot().bookings[0].desiredPresence).toBe("absent");
      expect(f.engine.snapshot().bookings[0].syncState).toBe("synced");
      expect(
        f.engine
          .snapshot()
          .operations.find((o) => o.id === moved.data.effects.operationIds[0])
          ?.status,
      ).toBe("succeeded");
    },
  );

  it("recovers PATCH404 for a never-observed insert using the original event identity", async () => {
    const f = fixture();
    f.calendar();
    const p = f.active(),
      t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
        .ticket;
    const created = f.apply("book_ticket", {
        ticketId: t.id,
        start: "2026-10-19T08:00:00+02:00",
        end: "2026-10-19T09:00:00+02:00",
        allowOverlap: false,
      }),
      b = created.data.booking;
    f.engine.completeOperation(created.data.effects.operationIds[0]); // A recovered legacy acknowledgment with no observed provider event.
    const moved = f.apply("move_booking", {
      bookingId: b.id,
      start: "2026-10-19T10:00:00+02:00",
      end: "2026-10-19T11:00:00+02:00",
      allowOverlap: false,
    });
    const fetcher = vi.fn(async (_url, init) => {
      if (init.method === "PATCH")
        return Response.json({ error: {} }, { status: 404 });
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body);
      expect(body.id).toBe(b.googleEventId);
      return Response.json({ ...body, etag: "created" });
    });
    vi.stubGlobal("fetch", fetcher);
    const store = Object.create(OrganizerStore.prototype) as any;
    store.engine = f.engine;
    store.ctx = { storage: { setAlarm: async () => {} } };
    store.env = {};
    store.credentials = async () => ({
      accessToken: "test-token",
      refreshToken: "unused",
      expiresAt: Infinity,
    });
    store.synchronize = async () => {};
    await store.alarm();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.engine.snapshot().bookings).toHaveLength(1);
    expect(f.engine.snapshot().bookings[0].googleEventId).toBe(b.googleEventId);
    expect(f.engine.snapshot().bookings[0].start).toBe(
      moved.data.booking.start,
    );
    expect(f.engine.snapshot().bookings[0].syncState).toBe("synced");
  });

  it("fetches requested future-day coverage even when account freshness is recent, preserving other windows", async () => {
    const f = fixture();
    f.calendar();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T16:00:00Z"));
    const near = {
      id: "near",
      summary: "Near busy",
      start: { dateTime: "2026-10-19T07:00:00+02:00" },
      end: { dateTime: "2026-10-19T09:00:00+02:00" },
    };
    const far = {
      id: "far",
      summary: "Future busy",
      start: { dateTime: "2027-02-10T07:00:00+01:00" },
      end: { dateTime: "2027-02-10T09:00:00+01:00" },
    };
    const fetcher = vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      const start = Date.parse(q.get("timeMin")!),
        end = Date.parse(q.get("timeMax")!);
      return Response.json({
        items: [near, far].filter(
          (e) =>
            Date.parse(e.start.dateTime) < end &&
            Date.parse(e.end.dateTime) > start,
        ),
        nextSyncToken: "token",
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const store = storeFor(f.engine);
    const future = (await store.execute(
      "find_free_starts",
      { date: "2027-02-10", lengthMinutes: 60 },
      actor,
    )) as any;
    expect(future.data.starts[0]).toBe("2027-02-10T08:00:00.000Z");
    const tomorrow = (await store.execute(
      "find_free_starts",
      { date: "2026-10-19", lengthMinutes: 60 },
      actor,
    )) as any;
    expect(tomorrow.data.starts[0]).toBe("2026-10-19T07:00:00.000Z");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      f.engine
        .snapshot()
        .events.map((e) => e.googleEventId)
        .sort(),
    ).toEqual(["far", "near"]);
    const firstUrl = new URL(fetcher.mock.calls[0][0]);
    expect(firstUrl.searchParams.get("timeMin")).toBe(
      "2027-02-09T23:00:00.000Z",
    );
    expect(firstUrl.searchParams.get("timeMax")).toBe(
      "2027-02-10T23:00:00.000Z",
    );
  });

  it("uses DST local-day coverage and preserves out-of-window cache when a full refresh removes an event", async () => {
    const f = fixture();
    f.calendar();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T16:00:00Z"));
    const fetcher = vi.fn(async (_url: string) =>
      Response.json({ items: [], nextSyncToken: "token" }),
    );
    vi.stubGlobal("fetch", fetcher);
    const store = storeFor(f.engine);
    await store.execute("find_free_starts", { date: "2026-10-25" }, actor);
    const url = new URL(fetcher.mock.calls[0][0] as string);
    expect(
      Date.parse(url.searchParams.get("timeMax")!) -
        Date.parse(url.searchParams.get("timeMin")!),
    ).toBe(25 * 3600000);
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [
        {
          id: "inside",
          start: "2026-10-19T08:00:00Z",
          end: "2026-10-19T09:00:00Z",
        },
        {
          id: "outside",
          start: "2027-01-01T08:00:00Z",
          end: "2027-01-01T09:00:00Z",
        },
      ],
    });
    f.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [],
      replace: true,
      replaceRange: {
        start: "2026-10-19T00:00:00Z",
        end: "2026-10-20T00:00:00Z",
      },
    });
    expect(f.engine.snapshot().events.map((e) => e.googleEventId)).toEqual([
      "outside",
    ]);
  });

  it("fails incomplete requested-window booking safely but replays a committed booking before provider I/O", async () => {
    const f = fixture();
    f.calendar();
    const p = f.active(),
      t = f.apply("create_ticket", { projectId: p.id, title: "Task" }).data
        .ticket;
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-18T16:00:00Z"));
    const args = {
      ticketId: t.id,
      start: "2027-02-10T08:00:00+01:00",
      end: "2027-02-10T09:00:00+01:00",
      allowOverlap: false,
      idempotencyKey: "coverage-test",
      expectedVersions: f.engine.snapshot().versions,
    };
    const fetcher = vi.fn(async () =>
      Response.json({ error: {} }, { status: 503 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const store = storeFor(f.engine);
    const failed = await store.execute("book_ticket", args, actor);
    expect(failed.error.code).toBe("AVAILABILITY_INCOMPLETE");
    expect(f.engine.snapshot().bookings).toHaveLength(0);
    f.engine.execute("book_ticket", args, actor);
    fetcher.mockClear();
    const replay = await store.execute("book_ticket", args, actor);
    expect(replay.data.deduplicated).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("expires disconnected external cache after 24 hours despite repeated failures or credential writes", () => {
    const f = fixture();
    f.engine.connectAccount({
      role: "work",
      email: "work@example.test",
      encryptedCredentials: "encrypted",
    });
    f.engine.reconcileCalendar({
      role: "work",
      calendarId: "primary",
      events: [
        {
          id: "external",
          start: "2026-10-20T08:00:00Z",
          end: "2026-10-20T09:00:00Z",
        },
      ],
    });
    f.engine.setAccountStatus("work", "needs_reconnect");
    f.setTime("2026-10-19T15:59:00Z");
    f.engine.setAccountStatus("work", "needs_reconnect");
    f.engine.updateAccountCredentials("work", "replacement-encrypted");
    expect(f.engine.snapshot().events).toHaveLength(1);
    f.setTime("2026-10-19T16:01:00Z");
    expect(f.engine.snapshot().events).toHaveLength(0);
  });

  it("returns UI hash-router links and the actual calendar authorization route", () => {
    const f = fixture(),
      p = f.project();
    const detail = f.engine.execute("get_item", { itemId: p.id }, actor) as any;
    expect(detail.data.href).toBe(`/#/project/${p.id}`);
    const book = f.apply("queue_book", {
      areaId: "self",
      source: { type: "manual", title: "Book", authors: [], pageCount: 100 },
    }).data.item;
    expect(
      (f.engine.execute("get_item", { itemId: book.id }, actor) as any).data
        .href,
    ).toBe(`/#/bookshelf/${book.id}`);
    expect(
      (
        f.engine.execute(
          "get_calendar_connect_link",
          { role: "personal" },
          actor,
        ) as any
      ).data.href,
    ).toBe("/auth/calendar?role=personal");
  });

  it("preserves wire error codes for mismatched receipt reuse and malformed calendar dates", async () => {
    const f = fixture(),
      p = f.project(),
      store = storeFor(f.engine);
    const args = {
      projectId: p.id,
      patch: { title: "First" },
      idempotencyKey: "wire-replay",
      expectedVersions: f.engine.snapshot().versions,
    };
    await store.execute("update_project", args, actor);
    const reused = await store.execute(
      "update_project",
      { ...args, patch: { title: "Different" } },
      actor,
    );
    expect(reused.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const invalid = await store.execute(
      "find_free_starts",
      { date: "2026-02-31" },
      actor,
    );
    expect(invalid.error.code).toBe("VALIDATION_ERROR");
    expect(fetcher).not.toHaveBeenCalled();
    const invalidReview = await store.execute(
      "get_review",
      { date: "2026-02-31" },
      actor,
    );
    expect(invalidReview.error.code).toBe("VALIDATION_ERROR");
  });
});
