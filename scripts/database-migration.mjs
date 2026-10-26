import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const TABLES = [
  "settings",
  "areas",
  "aggregate_versions",
  "projects",
  "books",
  "queue_entries",
  "calendar_accounts",
  "calendar_sources",
  "calendar_events",
  "tickets",
  "bookings",
  "reviews",
  "learnings",
  "daily_dismissals",
  "command_receipts",
  "audit_log",
  "outbox_operations",
  "cursors",
  "schema_versions",
];
const SEED_TABLES = new Set([
  "settings",
  "areas",
  "aggregate_versions",
  "schema_versions",
]);
export const identifier = (name) => {
  assert.match(name, /^[a-z][a-z0-9_]*$/, "Unsafe SQL identifier.");
  return `"${name}"`;
};
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function canonicalTables(tables) {
  return [...tables]
    .sort((a, b) => compare(a.name, b.name))
    .map((table) => ({
      name: table.name,
      columns: table.columns,
      rows: [...table.rows].sort((a, b) =>
        compare(JSON.stringify(a), JSON.stringify(b)),
      ),
    }));
}
export function digest(tables) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalTables(tables)))
    .digest("hex");
}
export function readDomain(database) {
  const actual = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("_"))
    .sort();
  assert.deepEqual(
    actual,
    [...TABLES].sort(),
    "Unexpected schema; update the migration before exporting.",
  );
  assert.deepEqual(
    database.prepare("PRAGMA foreign_key_check").all(),
    [],
    "Database has broken references.",
  );
  const tables = TABLES.map((name) => {
    const columns = database
      .prepare(`PRAGMA table_info(${identifier(name)})`)
      .all()
      .map((column) => column.name);
    const values = database
      .prepare(
        `SELECT ${columns.map(identifier).join(",")} FROM ${identifier(name)}`,
      )
      .all();
    return {
      name,
      columns,
      rows: values.map((row) => columns.map((column) => row[column])),
    };
  });
  const versions = tables
    .find((table) => table.name === "schema_versions")
    .rows.map((row) => row[0]);
  // Version 3 adds indexes only. Rows and columns are unchanged from version 2.
  assert.ok(
    versions.length > 0 &&
      versions.every(
        (version) => version === 1 || version === 2 || version === 3,
      ) &&
      Math.max(...versions) <= 3,
    "Unsupported database version.",
  );
  return {
    format: "organizer-sqlite-v1",
    createdAt: new Date().toISOString(),
    tables,
    digest: digest(tables),
  };
}
export function validateExport(value) {
  assert.equal(value.format, "organizer-sqlite-v1");
  assert.deepEqual(
    value.tables.map((table) => table.name).sort(),
    [...TABLES].sort(),
    "Migration must contain every domain table exactly once.",
  );
  for (const table of value.tables) {
    assert.ok(table.columns.length > 0 && table.columns.length <= 100);
    table.columns.forEach(identifier);
    assert.equal(new Set(table.columns).size, table.columns.length);
    for (const row of table.rows) {
      assert.equal(row.length, table.columns.length);
      assert.ok(
        row.every(
          (value) =>
            value === null ||
            typeof value === "string" ||
            (typeof value === "number" && Number.isSafeInteger(value)),
        ),
        "Unsupported database value.",
      );
    }
  }
  assert.equal(
    value.digest,
    digest(value.tables),
    "Database export checksum mismatch.",
  );
}
export function assertEmptyTarget(tables) {
  for (const table of tables) {
    if (!SEED_TABLES.has(table.name))
      assert.equal(
        table.rows.length,
        0,
        `Refusing to overwrite existing ${table.name}.`,
      );
  }
}
export function importQueries(value) {
  validateExport(value);
  const queries = [];
  const pointers = [];
  for (const name of TABLES) {
    const table = value.tables.find((table) => table.name === name);
    for (const original of table.rows) {
      const row = [...original];
      if (name === "tickets") {
        const booking = table.columns.indexOf("current_booking_id");
        if (booking >= 0 && row[booking] !== null) {
          pointers.push({
            sql: "UPDATE tickets SET current_booking_id=? WHERE id=?",
            params: [row[booking], row[table.columns.indexOf("id")]],
          });
          row[booking] = null;
        }
      }
      queries.push({
        sql: `INSERT INTO ${identifier(name)} (${table.columns.map(identifier).join(",")}) VALUES (${row.map(() => "?").join(",")})`,
        params: row,
      });
    }
  }
  const compact = [];
  for (const query of [...queries, ...pointers]) {
    const previous = compact.at(-1);
    const parts = query.sql.startsWith("INSERT INTO ")
      ? query.sql.split(" VALUES ")
      : [];
    if (
      parts.length === 2 &&
      previous?.sql.startsWith(`${parts[0]} VALUES `) &&
      previous.params.length + query.params.length <= 100
    ) {
      previous.sql += `,${parts[1]}`;
      previous.params.push(...query.params);
    } else compact.push(query);
  }
  for (const query of compact) {
    const name = query.sql.match(/^INSERT INTO "([a-z_]+)" /)?.[1];
    if (SEED_TABLES.has(name)) {
      const columns = value.tables.find((table) => table.name === name).columns;
      query.sql += ` ON CONFLICT DO UPDATE SET ${columns.map((column) => `${identifier(column)}=excluded.${identifier(column)}`).join(",")}`;
    }
  }
  return compact;
}
export async function backupDatabase(source, directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const snapshot = path.join(directory, "database.sqlite");
  const output = path.join(directory, "database.json");
  const file = await fs.open(snapshot, "wx", 0o600);
  await file.close();
  const live = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(live, snapshot);
  } finally {
    live.close();
  }
  const frozen = new DatabaseSync(snapshot, { readOnly: true });
  let exported;
  try {
    assert.equal(frozen.prepare("PRAGMA quick_check").get().quick_check, "ok");
    exported = readDomain(frozen);
  } finally {
    frozen.close();
  }
  await fs.writeFile(output, JSON.stringify(exported), {
    flag: "wx",
    mode: 0o600,
  });
  return exported;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [command, source, directory] = process.argv.slice(2);
    assert.equal(
      command,
      "backup",
      "Usage: node scripts/database-migration.mjs backup SOURCE.sqlite PRIVATE_DIRECTORY",
    );
    assert.ok(
      source && directory,
      "Source database and backup directory are required.",
    );
    const exported = await backupDatabase(source, directory);
    console.log(
      JSON.stringify({
        directory,
        digest: exported.digest,
        counts: Object.fromEntries(
          exported.tables.map((table) => [table.name, table.rows.length]),
        ),
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
