import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";

type MigratedSnapshot = {
  items: {
    id: string;
    kind: string;
    progressUnit?: string;
    pageCount?: number;
    currentPage?: number;
    version?: string;
  }[];
  learnings: { id: string; bookId?: string; text: string }[];
};

const root = path.resolve("tests/workerd");
const workerConfig = {
  name: "organizer-migration",
  compatibility_date: "2026-10-18",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [{ name: "ORGANIZER", class_name: "OrganizerStore" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["OrganizerStore"] }],
};

async function rows(
  server: TestHarness,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const storage = await server
    .getWorker()
    .getDurableObjectStorage("OrganizerStore", { name: "owner" });
  return storage.exec(sql);
}

describe("workerd books migration", () => {
  let server: TestHarness | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("rebuilds a v1 database that other tables reference", async () => {
    server = createTestHarness({
      root,
      workers: [
        {
          config: {
            ...workerConfig,
            main: path.join(root, "seed-worker.js"),
          },
        },
      ],
    });
    await server.listen();
    const seeded = await server.fetch("http://example.com/");
    expect(seeded.status).toBe(200);

    await server
      .getWorker()
      .evictDurableObject("OrganizerStore", { name: "owner" });
    await server.update({
      root,
      workers: [
        {
          config: {
            ...workerConfig,
            main: path.join(root, "migrate-worker.ts"),
          },
        },
      ],
    });

    const migrated = await server.fetch("http://example.com/snapshot");
    expect(migrated.status, await migrated.clone().text()).toBe(200);
    // The rebuild turns foreign keys off. workerd applies PRAGMA foreign_keys=ON
    // on the next event, so the second snapshot is what re-enables them.
    const confirmed = await server.fetch("http://example.com/snapshot");
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    const snapshot = (await confirmed.json()) as MigratedSnapshot;
    const books = snapshot.items.filter((item) => item.kind === "book");
    expect(books.map((book) => book.id).sort()).toEqual([
      "book_meditations",
      "book_mom",
      "book_odyssey",
    ]);
    expect(books.find((book) => book.id === "book_meditations")).toMatchObject({
      progressUnit: "pages",
      pageCount: 254,
      currentPage: 40,
      version: "3",
    });
    expect(snapshot.learnings).toEqual([
      expect.objectContaining({
        id: "learn_meditations",
        bookId: "book_meditations",
        text: "Keep this note",
      }),
    ]);

    expect(await rows(server, "PRAGMA foreign_keys")).toEqual([
      { foreign_keys: 1 },
    ]);
    expect(await rows(server, "PRAGMA foreign_key_check")).toEqual([]);
    expect(
      await rows(
        server,
        "SELECT version FROM schema_versions ORDER BY version",
      ),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(
      await rows(server, "SELECT id, book_id FROM queue_entries ORDER BY id"),
    ).toEqual([
      { id: "queue_mom", book_id: "book_mom" },
      { id: "queue_odyssey", book_id: "book_odyssey" },
    ]);

    await server
      .getWorker()
      .evictDurableObject("OrganizerStore", { name: "owner" });
    const restarted = await server.fetch("http://example.com/snapshot");
    expect(restarted.status, await restarted.clone().text()).toBe(200);
    const again = (await restarted.json()) as MigratedSnapshot;
    expect(
      again.items.find((item) => item.id === "book_meditations"),
    ).toMatchObject({ currentPage: 40, pageCount: 254, version: "3" });
    expect(await rows(server, "PRAGMA foreign_keys")).toEqual([
      { foreign_keys: 1 },
    ]);
    expect(await rows(server, "PRAGMA foreign_key_check")).toEqual([]);
    expect(
      await rows(
        server,
        "SELECT version FROM schema_versions ORDER BY version",
      ),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    expect(await rows(server, "SELECT COUNT(*) AS n FROM books")).toEqual([
      { n: 3 },
    ]);
    expect(await rows(server, "SELECT COUNT(*) AS n FROM learnings")).toEqual([
      { n: 1 },
    ]);
  }, 30000);

  it("re-enables foreign keys when the first event after migration is an alarm", async () => {
    server = createTestHarness({
      root,
      workers: [
        {
          config: {
            ...workerConfig,
            main: path.join(root, "seed-worker.js"),
          },
        },
      ],
    });
    await server.listen();
    const seeded = await server.fetch("http://example.com/");
    expect(seeded.status).toBe(200);

    await server
      .getWorker()
      .evictDurableObject("OrganizerStore", { name: "owner" });
    await server.update({
      root,
      workers: [
        {
          config: {
            ...workerConfig,
            main: path.join(root, "alarm-worker.ts"),
          },
        },
      ],
    });

    // Migration runs in this request, and the only write after it is setAlarm.
    // The alarm that fires next is the first event after migration.
    const armed = await server.fetch("http://example.com/arm");
    expect(armed.status, await armed.clone().text()).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(await rows(server, "SELECT note FROM alarm_marker")).toEqual([
      { note: "ran" },
    ]);
    expect(await rows(server, "PRAGMA foreign_keys")).toEqual([
      { foreign_keys: 1 },
    ]);
    await expect(
      rows(
        server,
        "INSERT INTO queue_entries(id,area_id,position,book_id) VALUES('queue_bad','tech',1,'missing-book')",
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    expect(
      await rows(server, "SELECT id FROM queue_entries WHERE id='queue_bad'"),
    ).toEqual([]);
    expect(await rows(server, "PRAGMA foreign_key_check")).toEqual([]);
    expect(await rows(server, "SELECT id FROM books ORDER BY id")).toEqual([
      { id: "book_meditations" },
      { id: "book_mom" },
      { id: "book_odyssey" },
    ]);
  }, 30000);
});
