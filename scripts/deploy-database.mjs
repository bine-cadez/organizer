import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseEnv } from "node:util";
import { cloudflareApi } from "./cloudflare-api.mjs";
import {
  TABLES,
  assertEmptyTarget,
  digest,
  identifier,
  importQueries,
  validateExport,
} from "./database-migration.mjs";

// Operator-only: Cloudflare authentication is required; no app restore route exists.
try {
  const [command, file] = process.argv.slice(2);
  assert.ok(
    ["import", "verify"].includes(command) && file,
    "Usage: node scripts/deploy-database.mjs import|verify PRIVATE_EXPORT.json",
  );
  const exported = JSON.parse(await fs.readFile(file, "utf8"));
  validateExport(exported);
  const local = parseEnv(await fs.readFile(".dev.vars", "utf8"));
  const account = exported.tables.find(
    (table) => table.name === "calendar_accounts",
  );
  const personal = account.rows.find(
    (row) => row[account.columns.indexOf("role")] === "personal",
  );
  assert.equal(
    personal?.[account.columns.indexOf("email")],
    local.OWNER_EMAIL,
    "Verified Personal calendar must belong to the configured owner.",
  );
  const owner = personal[account.columns.indexOf("google_subject")];
  assert.ok(
    typeof owner === "string" && owner.length > 0,
    "Verified owner subject is required.",
  );
  const config = JSON.parse(
    (await fs.readFile("wrangler.jsonc", "utf8")).replace(/,\s*([}\]])/g, "$1"),
  );
  const api = await cloudflareApi();
  const base = `/accounts/${config.account_id}/workers`;
  const namespaces = await api(`${base}/durable_objects/namespaces`);
  const namespace = namespaces.find(
    (value) =>
      value.script === config.name &&
      value.class === "OrganizerStore" &&
      value.use_sqlite,
  );
  assert.ok(namespace, "Deployed Organizer SQLite namespace not found.");
  const query = async (queries) => {
    const result = await api(
      `${base}/durable_objects/namespaces/${namespace.id}/query/v2`,
      {
        method: "POST",
        body: JSON.stringify({
          durable_object_name: owner,
          jurisdiction: "none",
          queries,
        }),
      },
    );
    assert.equal(
      result.results.length,
      queries.length,
      "Cloudflare returned incomplete query results.",
    );
    return result.results;
  };
  const readTables = async () => {
    const [schema] = await query([
      {
        sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\'",
      },
    ]);
    assert.deepEqual(
      schema.rows.map((row) => row[0]).sort(),
      [...TABLES].sort(),
      "Remote schema differs from the export.",
    );
    const results = await query(
      exported.tables.map((table) => ({
        sql: `SELECT ${table.columns.map(identifier).join(",")} FROM ${identifier(table.name)}`,
      })),
    );
    return results.map((result, index) => {
      assert.deepEqual(result.columns, exported.tables[index].columns);
      return {
        name: exported.tables[index].name,
        columns: result.columns,
        rows: result.rows,
      };
    });
  };
  const before = await readTables();
  if (command === "import" && digest(before) !== exported.digest) {
    const settings = await api(`${base}/scripts/${config.name}/settings`);
    assert.ok(
      !settings.bindings.some((binding) =>
        ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].includes(binding.name),
      ),
      "Keep production Google sign-in disabled until the import is verified.",
    );
    assertEmptyTarget(before);
    const queries = importQueries(exported);
    for (let index = 0; index < queries.length; index++) {
      await query([queries[index]]);
      console.log(`Imported batch ${index + 1}/${queries.length}`);
    }
  }
  const after = await readTables();
  assert.equal(
    digest(after),
    exported.digest,
    "Remote data does not match the frozen backup. Keep sign-in disabled and inspect the import.",
  );
  const [references] = await query([{ sql: "PRAGMA foreign_key_check" }]);
  assert.equal(
    references.rows.length,
    0,
    "Remote database has broken references.",
  );
  console.log(
    JSON.stringify({
      verified: true,
      digest: exported.digest,
      counts: Object.fromEntries(
        after.map((table) => [table.name, table.rows.length]),
      ),
    }),
  );
} catch (error) {
  // SQL/provider errors may contain private values; only the safe operator message is printed.
  console.error(error.message);
  process.exitCode = 1;
}
