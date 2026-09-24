const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("path");

const DB_PATH = process.env.GRANOLA_DB_PATH || path.join(__dirname, "data", "granola-documents.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
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

if (!db.prepare("PRAGMA table_info(documents)").all().some((c) => c.name === "panel_text")) {
  db.exec("ALTER TABLE documents ADD COLUMN panel_text TEXT");
  // Existing rows lack summaries; drop the cache so the next sync refetches everything.
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM sync_meta");
}

// Bump when cached rows need refetching. v1: folder-synced docs were fetched without their AI summary panel.
const CACHE_VERSION = 1;
if (db.prepare("PRAGMA user_version").get().user_version < CACHE_VERSION) {
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM sync_meta");
  db.exec(`PRAGMA user_version = ${CACHE_VERSION}`);
}

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder);");
db.exec("CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);");

function proseMirrorText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text || "";
  const inner = (node.content || []).map(proseMirrorText).join(node.type === "doc" || node.type.endsWith("list") ? "\n" : "");
  return /^(paragraph|heading|listItem|list_item)$/.test(node.type) ? `${inner}\n` : inner;
}

// `folder === undefined` keeps an existing row's folder (used for docs synced outside any folder list).
function upsertDocuments(docs, folder) {
  if (!docs.length) return;
  db.exec("BEGIN TRANSACTION");
  try {
    const stmt = db.prepare(`
      INSERT INTO documents
        (id, title, created_at, updated_at, notes_plain, notes_markdown, people_json, folder, synced_at, panel_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        notes_plain = excluded.notes_plain,
        notes_markdown = excluded.notes_markdown,
        people_json = excluded.people_json,
        folder = CASE WHEN ? THEN documents.folder ELSE excluded.folder END,
        synced_at = excluded.synced_at,
        panel_text = excluded.panel_text
    `);
    const now = Date.now();
    const keepFolder = folder === undefined ? 1 : 0;
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
        now,
        proseMirrorText(doc.last_viewed_panel?.content).trim(),
        keepFolder
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
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

function setFolderSyncAt(folderId, updatedAt) {
  const stmt = db.prepare(
    "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  stmt.run(`folder_updated_at:${folderId}`, updatedAt);
}

function getFolderSyncAt(folderId) {
  const stmt = db.prepare("SELECT value FROM sync_meta WHERE key = ?");
  const row = stmt.get(`folder_updated_at:${folderId}`);
  return row ? row.value : null;
}

function buildSearchSql(terms, folder) {
  const conditions = [];
  const params = [];
  for (const t of terms) {
    const like = `%${t}%`;
    conditions.push(
      "(LOWER(title) LIKE ? OR LOWER(notes_plain) LIKE ? OR LOWER(notes_markdown) LIKE ? OR LOWER(people_json) LIKE ? OR LOWER(panel_text) LIKE ?)"
    );
    params.push(like, like, like, like, like);
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
  const sql = `SELECT id, title, created_at, notes_plain, panel_text, folder FROM documents WHERE ${where} ORDER BY created_at DESC LIMIT ?`;
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

function getAllDocumentIds() {
  const stmt = db.prepare("SELECT id FROM documents");
  return new Set(stmt.all().map((r) => r.id));
}

function deleteDocument(id) {
  const stmt = db.prepare("DELETE FROM documents WHERE id = ?");
  stmt.run(id);
}

function deleteDocuments(ids) {
  if (!ids.length) return;
  const chunkSize = 500;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => "?").join(",");
    const stmt = db.prepare(`DELETE FROM documents WHERE id IN (${placeholders})`);
    stmt.run(...chunk);
  }
}

function clearDocuments() {
  db.exec("DELETE FROM documents");
  db.exec("DELETE FROM sync_meta");
}

module.exports = {
  upsertDocuments,
  setLastSyncedAt,
  getLastSyncedAt,
  setFolderSyncAt,
  getFolderSyncAt,
  searchDocuments,
  countDocuments,
  getDocument,
  getDocumentIdsForFolder,
  getAllDocumentIds,
  deleteDocument,
  deleteDocuments,
  clearDocuments,
  proseMirrorText,
};
