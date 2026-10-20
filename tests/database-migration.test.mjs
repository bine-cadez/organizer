import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrganizerEngine } from "../src/domain/engine";
import { ALL_SCOPES } from "../src/shared/types";
import {
  assertEmptyTarget,
  backupDatabase,
  importQueries,
  readDomain,
  validateExport,
} from "../scripts/database-migration.mjs";

const open = [],
  directories = [];
function fixture(file = ":memory:") {
  const db = new DatabaseSync(file);
  open.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const port = {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    transaction: (fn) => {
      db.exec("BEGIN");
      try {
        const value = fn();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const engine = new OrganizerEngine(port, {
    now: () => Date.parse("2026-10-19T08:00:00Z"),
  });
  let sequence = 0;
  const apply = (name, args = {}) =>
    engine.execute(
      name,
      {
        ...args,
        idempotencyKey: `migration-${++sequence}`,
        expectedVersions: engine.snapshot().versions,
      },
      { id: "owner", type: "human", scopes: ALL_SCOPES },
    );
  return { db, engine, apply, port };
}
afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("database transfer", () => {
  it("migrates a page-only books table and keeps the existing page and count", () => {
    const db = new DatabaseSync(":memory:");
    open.push(db);
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(
      `CREATE TABLE areas(id TEXT PRIMARY KEY CHECK(id IN ('tech','sales','ship','self')), code TEXT NOT NULL, name TEXT NOT NULL, full_name TEXT NOT NULL)`,
    );
    db.exec(
      `INSERT INTO areas(id,code,name,full_name) VALUES('self','G','General','General Self-improvement')`,
    );
    db.exec(
      `CREATE TABLE books(id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES areas(id), title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120), authors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(authors_json) AND json_type(authors_json)='array'), work_id TEXT, edition_id TEXT, isbn TEXT, cover_url TEXT, cover_id TEXT, page_count INTEGER NOT NULL CHECK(page_count>0 AND page_count<=100000), page_count_source TEXT NOT NULL CHECK(page_count_source IN ('edition','work_median','manual')), current_page INTEGER NOT NULL DEFAULT 0 CHECK(current_page>=0 AND current_page<=page_count), state TEXT NOT NULL CHECK(state IN ('queued','active','paused','archived','done')), started_at INTEGER, paused_at INTEGER, archived_at INTEGER, done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0))`,
    );
    db.prepare(
      `INSERT INTO books(id,area_id,title,authors_json,page_count,page_count_source,current_page,state,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      "book_old",
      "self",
      "Meditations",
      '["Marcus Aurelius"]',
      254,
      "manual",
      40,
      "active",
      1,
      1,
      3,
    );
    const port = {
      all: (sql, ...params) => db.prepare(sql).all(...params),
      run: (sql, ...params) => db.prepare(sql).run(...params),
      transaction: (fn) => {
        db.exec("BEGIN");
        try {
          const value = fn();
          db.exec("COMMIT");
          return value;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
    const engine = new OrganizerEngine(port, {
      now: () => Date.parse("2026-10-19T08:00:00Z"),
    });
    const book = engine.snapshot().items.find((item) => item.id === "book_old");
    expect(book?.progressUnit).toBe("pages");
    expect(book?.pageCount).toBe(254);
    expect(book?.currentPage).toBe(40);
    expect(book?.durationMinutes).toBeUndefined();
    expect(book?.positionMinutes).toBeUndefined();
    expect(book?.version).toBe("3");
    const columns = db
      .prepare("PRAGMA table_info(books)")
      .all()
      .map((column) => column.name);
    expect(columns).toContain("progress_unit");
    expect(columns).toContain("duration_minutes");
    expect(columns).toContain("position_minutes");
    expect(db.prepare("PRAGMA foreign_keys").get().foreign_keys).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const versions = db
      .prepare("SELECT version FROM schema_versions")
      .all()
      .map((row) => row.version);
    expect(versions).toContain(2);
    engine.execute(
      "set_book_progress",
      {
        bookId: "book_old",
        currentPage: 41,
        idempotencyKey: "migrated-page",
        expectedVersions: engine.snapshot().versions,
      },
      { id: "owner", type: "human", scopes: ALL_SCOPES },
    );
    expect(
      engine.snapshot().items.find((item) => item.id === "book_old")
        ?.currentPage,
    ).toBe(41);
  });
  it("round trips every domain table, including booking cycles, credentials, receipts and final reviews", () => {
    const source = fixture(),
      target = fixture();
    const project = source.apply("queue_project", {
      areaId: "tech",
      title: "Reader's project",
    }).data.item;
    source.apply("start_item", { itemId: project.id });
    const ticket = source.apply("create_ticket", {
      projectId: project.id,
      title: "Read “Meditations”",
    }).data.ticket;
    source.engine.connectAccount({
      role: "personal",
      email: "owner@example.test",
      googleSubject: "verified-owner",
      encryptedCredentials: "opaque-encrypted-credentials",
    });
    source.engine.reconcileCalendar({
      role: "personal",
      calendarId: "primary",
      events: [],
    });
    source.apply("book_ticket", {
      ticketId: ticket.id,
      start: "2026-10-19T10:00:00Z",
      end: "2026-10-19T11:00:00Z",
    });
    const book = source.apply("queue_book", {
      areaId: "self",
      source: {
        type: "manual",
        title: "Meditations",
        authors: ["Marcus Aurelius"],
        pageCount: 254,
      },
    }).data.item;
    source.apply("start_item", { itemId: book.id });
    source.apply("set_book_progress", { bookId: book.id, currentPage: 15 });
    source.apply("add_learning", {
      target: { kind: "book", id: book.id },
      text: "A reader's note — Življenje.",
    });
    source.db
      .prepare(
        "INSERT INTO reviews(id,review_date,baseline_json,saved_json,saved_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        "final-review",
        "2026-10-18",
        "{}",
        '{"completedTicketIds":[]}',
        1,
        1,
        1,
      );
    const exported = readDomain(source.db);
    assertEmptyTarget(readDomain(target.db).tables);
    for (const query of importQueries(exported)) {
      // Every Cloudflare query can arrive after a fresh Durable Object constructor.
      new OrganizerEngine(target.port);
      expect(query.params?.length || 0).toBeLessThanOrEqual(100);
      target.db.prepare(query.sql).run(...(query.params || []));
    }
    expect(readDomain(target.db).digest).toBe(exported.digest);
    expect(target.engine.snapshot()).toEqual(source.engine.snapshot());
    expect(() =>
      target.db
        .prepare("UPDATE reviews SET saved_at=2 WHERE id=?")
        .run("final-review"),
    ).toThrow("Saved reviews are final");
  });
  it("rejects tampered exports and occupied targets", () => {
    const source = fixture();
    const exported = readDomain(source.db);
    exported.tables.find((table) => table.name === "areas").rows[0][1] =
      "changed";
    expect(() => validateExport(exported)).toThrow("checksum");
    source.apply("queue_project", {
      areaId: "tech",
      title: "Existing real data",
    });
    expect(() => assertEmptyTarget(readDomain(source.db).tables)).toThrow(
      "Refusing to overwrite",
    );
  });
  it("creates a consistent private SQLite snapshot and matching JSON export", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "organizer-migration-"),
    );
    directories.push(directory);
    const source = fixture(path.join(directory, "source.sqlite"));
    source.apply("queue_project", {
      areaId: "tech",
      title: "Persisted before export",
    });
    const output = path.join(directory, "backup");
    const exported = await backupDatabase(
      path.join(directory, "source.sqlite"),
      output,
    );
    const json = JSON.parse(
      await readFile(path.join(output, "database.json"), "utf8"),
    );
    expect(json.digest).toBe(exported.digest);
    expect(exported.digest).toBe(readDomain(source.db).digest);
    expect(
      (await stat(path.join(output, "database.sqlite"))).mode & 0o777,
    ).toBe(0o600);
    expect((await stat(path.join(output, "database.json"))).mode & 0o777).toBe(
      0o600,
    );
  });
});
