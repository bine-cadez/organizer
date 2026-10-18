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
