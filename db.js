const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const DB_PATH = process.env.GRANOLA_DB_PATH || path.join(__dirname, "granola-documents.db");
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT,
    updated_at TEXT,
    notes_plain TEXT,
    notes_markdown TEXT,
    people_json TEXT,
    folder TEXT,
    synced_at INTEGER
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sync_meta (
    key TEXT PRIMARY KEY,
    value INTEGER
  );
`);

function upsertDocuments(docs, folder) {
  const stmt = db.prepare(`
    INSERT INTO documents
      (id, title, created_at, updated_at, notes_plain, notes_markdown, people_json, folder, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      notes_plain = excluded.notes_plain,
      notes_markdown = excluded.notes_markdown,
      people_json = excluded.people_json,
      folder = excluded.folder,
      synced_at = excluded.synced_at
  `);
  const now = Date.now();
  for (const doc of docs) {
    const people = JSON.stringify(doc.people || []);
    stmt.run(
      doc.id,
      doc.title || "",
      doc.created_at || "",
      doc.updated_at || "",
      doc.notes_plain || "",
      doc.notes_markdown || "",
      people,
      folder || "",
      now
    );
  }
}

function setLastSyncedAt(ts) {
  const stmt = db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  stmt.run("last_sync", ts);
}

function getLastSyncedAt() {
  const stmt = db.prepare("SELECT value FROM sync_meta WHERE key = ?");
  const row = stmt.get("last_sync");
  return row ? row.value : 0;
}

function buildSearchSql(terms, folder) {
  const conditions = [];
  const params = [];
  for (const t of terms) {
    const like = `%${t}%`;
    conditions.push(
      "(LOWER(title) LIKE ? OR LOWER(notes_plain) LIKE ? OR LOWER(notes_markdown) LIKE ? OR LOWER(people_json) LIKE ?)"
    );
    params.push(like, like, like, like);
  }
  let where = conditions.join(" AND ");
  if (folder) {
    where += " AND folder = ?";
    params.push(folder);
  }
  return { where, params };
}

function searchDocuments(terms, { folder, limit = 100 } = {}) {
  const { where, params } = buildSearchSql(terms, folder);
  const sql = `SELECT id, title, created_at, notes_plain, folder FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT ?`;
  params.push(limit);
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

function countDocuments(terms, { folder } = {}) {
  const { where, params } = buildSearchSql(terms, folder);
  const sql = `SELECT COUNT(*) AS c FROM documents WHERE ${where}`;
  const stmt = db.prepare(sql);
  const row = stmt.get(...params);
  return row ? row.c : 0;
}

function getDocument(id) {
  const stmt = db.prepare("SELECT * FROM documents WHERE id = ?");
  return stmt.get(id) || null;
}

function getDocumentIdsForFolder(folder) {
  const stmt = db.prepare("SELECT id FROM documents WHERE folder = ?");
  return stmt.all(folder).map((r) => r.id);
}

function deleteDocument(id) {
  const stmt = db.prepare("DELETE FROM documents WHERE id = ?");
  stmt.run(id);
}

function clearDocuments() {
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM sync_meta");
}

module.exports = {
  upsertDocuments,
  setLastSyncedAt,
  getLastSyncedAt,
  searchDocuments,
  countDocuments,
  getDocument,
  getDocumentIdsForFolder,
  deleteDocument,
  clearDocuments,
};
