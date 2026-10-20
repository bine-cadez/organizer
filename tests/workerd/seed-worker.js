import { DurableObject } from "cloudflare:workers";

const BOOKS = `CREATE TABLE books(
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL REFERENCES areas(id),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120),
  authors_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(authors_json) AND json_type(authors_json)='array'),
  work_id TEXT,
  edition_id TEXT,
  isbn TEXT,
  cover_url TEXT,
  cover_id TEXT,
  page_count INTEGER NOT NULL CHECK(page_count>0 AND page_count<=100000),
  page_count_source TEXT NOT NULL CHECK(page_count_source IN ('edition','work_median','manual')),
  current_page INTEGER NOT NULL DEFAULT 0 CHECK(current_page>=0 AND current_page<=page_count),
  state TEXT NOT NULL CHECK(state IN ('queued','active','paused','archived','done')),
  started_at INTEGER,
  paused_at INTEGER,
  archived_at INTEGER,
  done_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0)
)`;

export class OrganizerStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const existing = sql
      .exec("SELECT name FROM sqlite_master WHERE name='books'")
      .toArray();
    if (existing.length) return;
    ctx.storage.transactionSync(() => {
      sql.exec(
        "CREATE TABLE schema_versions(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      sql.exec("INSERT INTO schema_versions(version, applied_at) VALUES(1, 1)");
      sql.exec(
        "CREATE TABLE areas(id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, full_name TEXT NOT NULL)",
      );
      sql.exec(
        "INSERT INTO areas(id, code, name, full_name) VALUES('tech','T','Tech','Tech Improvement'),('sales','S','Sales','Sales & Business'),('self','G','General','General'),('ship','P','Ship','Product Shipping')",
      );
      sql.exec(BOOKS);
      sql.exec(
        "INSERT INTO books(id, area_id, title, authors_json, page_count, page_count_source, current_page, state, created_at, updated_at, version) VALUES('book_meditations','self','Meditations','[\"Marcus Aurelius\"]',254,'manual',40,'active',1,1,3)",
      );
      sql.exec(
        "INSERT INTO books(id, area_id, title, authors_json, page_count, page_count_source, current_page, state, created_at, updated_at, version) VALUES('book_mom','tech','The Mom Test','[\"Rob Fitzpatrick\"]',138,'manual',0,'queued',1,1,1)",
      );
      sql.exec(
        "INSERT INTO books(id, area_id, title, authors_json, page_count, page_count_source, current_page, state, created_at, updated_at, version) VALUES('book_odyssey','sales','The Odyssey','[\"Homer\"]',300,'edition',12,'queued',1,1,1)",
      );
      sql.exec(
        "CREATE TABLE projects(id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES areas(id), title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120), goal TEXT, state TEXT NOT NULL CHECK(state IN ('queued','active','paused','archived','done')), started_at INTEGER, paused_at INTEGER, archived_at INTEGER, done_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0))",
      );
      sql.exec(
        "CREATE TABLE reviews(id TEXT PRIMARY KEY, review_date TEXT NOT NULL UNIQUE, draft_json TEXT CHECK(draft_json IS NULL OR json_valid(draft_json)), baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)), saved_json TEXT CHECK(saved_json IS NULL OR json_valid(saved_json)), saved_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, CHECK((saved_at IS NULL AND saved_json IS NULL AND draft_json IS NOT NULL) OR (saved_at IS NOT NULL AND saved_json IS NOT NULL AND draft_json IS NULL)))",
      );
      sql.exec(
        "CREATE TABLE queue_entries(id TEXT PRIMARY KEY, area_id TEXT NOT NULL REFERENCES areas(id), position INTEGER NOT NULL, project_id TEXT UNIQUE REFERENCES projects(id), book_id TEXT UNIQUE REFERENCES books(id), CHECK((project_id IS NOT NULL)+(book_id IS NOT NULL)=1), UNIQUE(area_id,position))",
      );
      sql.exec(
        "INSERT INTO queue_entries(id, area_id, position, book_id) VALUES('queue_mom','tech',0,'book_mom'),('queue_odyssey','sales',0,'book_odyssey')",
      );
      sql.exec(
        "CREATE TABLE learnings(id TEXT PRIMARY KEY, text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000), created_on TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('direct','review')), review_id TEXT UNIQUE REFERENCES reviews(id), project_id TEXT REFERENCES projects(id), book_id TEXT REFERENCES books(id), created_by_actor_id TEXT NOT NULL, created_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, CHECK((project_id IS NOT NULL)+(book_id IS NOT NULL)=1), CHECK((source_kind='review' AND review_id IS NOT NULL) OR (source_kind='direct' AND review_id IS NULL)))",
      );
      sql.exec(
        "INSERT INTO learnings(id, text, created_on, source_kind, book_id, created_by_actor_id, created_at) VALUES('learn_meditations','Keep this note','2026-10-18','direct','book_meditations','owner',1)",
      );
    });
  }
  ping() {
    return { ok: true };
  }
}

export default {
  async fetch(_request, env) {
    const stub = env.ORGANIZER.get(env.ORGANIZER.idFromName("owner"));
    return Response.json(await stub.ping());
  },
};
