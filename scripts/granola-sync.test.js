const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdpkit-granola-"));
process.env.GRANOLA_DB_PATH = path.join(tmp, "granola.db");

const primitives = require("../primitives");
const db = require("../db");
const granola = require("../drivers/granola");

const doc = (id, updated_at = "1") => ({ id, title: `Doc ${id}`, created_at: "2026-01-01", updated_at, notes_plain: `notes ${id}` });

// Fake Granola renderer: getCache returns folder lists; API calls are routed by endpoint name.
function fakeGranola(t, { lists, meta, onList, onBatch, onOwn = () => ({ docs: [] }) }) {
  t.mock.method(primitives, "eval", async (_client, expression) => {
    if (expression.includes("getCache")) {
      return { workspaceId: "ws", ids: [], documentLists: lists, folders: Object.keys(meta).map((id) => ({ id })), folderMeta: meta, total: 0 };
    }
    const [, version, endpoint] = expression.match(/api\.granola\.ai\/(v\d)\/' \+ "([^"]+)"/);
    const body = JSON.parse(expression.match(/body: JSON\.stringify\((\{.*\})\)/)[1]);
    if (endpoint === "get-document-list") return onList(body);
    if (endpoint === "get-documents-batch") return onBatch(body);
    if (version === "v2" && endpoint === "get-documents") return onOwn(body);
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
}

test("sync survives a folder whose get-document-list returns 500", async (t) => {
  db.clearDocuments();
  db.setLastSyncedAt(1);
  const lists = { small: ["a"], huge: ["b", "c"] };
  const meta = { small: { updated_at: "2026-02-01T00:00:00Z" }, huge: { updated_at: "2026-02-01T00:00:00Z" } };
  db.setFolderSyncAt("small", "2026-01-01T00:00:00Z");
  db.setFolderSyncAt("huge", "2026-01-01T00:00:00Z");
  db.upsertDocuments([doc("stale")], "huge");
  fakeGranola(t, {
    lists,
    meta,
    onList: ({ list_id }) => {
      if (list_id === "huge") throw new Error('get-document-list 500: {"message":"Internal Server Error"}');
      return { documents: [{ id: "a", updated_at: "2" }] };
    },
    onBatch: ({ document_ids }) => {
      assert.ok(document_ids.length <= 50);
      return { docs: document_ids.map((id) => doc(id, "2")) };
    },
  });

  await granola.syncDocuments({});

  assert.ok(db.getLastSyncedAt() > 1);
  assert.deepEqual(db.getDocumentIdsForFolder("huge").sort(), ["b", "c"]);
  assert.deepEqual(db.getDocumentIdsForFolder("small"), ["a"]);
  assert.equal(db.getFolderSyncAt("huge"), "2026-02-01T00:00:00Z");
});

test("sync indexes unfiled notes and their AI summaries without clobbering folders", async (t) => {
  db.clearDocuments();
  const panel = { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Singapore Bedrock capacity is tight" }] }] } };
  const own = [
    { ...doc("unfiled", "5"), last_viewed_panel: panel },
    doc("filed", "5"),
  ];
  const pages = [];
  fakeGranola(t, {
    lists: { f1: ["filed"] },
    meta: { f1: { updated_at: "2026-02-01T00:00:00Z" } },
    onList: () => { throw new Error("not used on first sync"); },
    onBatch: ({ document_ids }) => ({ docs: document_ids.map((id) => doc(id, "5")) }),
    onOwn: ({ limit, offset, include_last_viewed_panel }) => {
      assert.equal(include_last_viewed_panel, true);
      pages.push(offset);
      return { docs: own.slice(offset, offset + limit), deleted: [] };
    },
  });

  await granola.syncDocuments({});

  assert.deepEqual(pages, [0]);
  const hits = db.searchDocuments(["bedrock"]);
  assert.deepEqual(hits.map((h) => h.id), ["unfiled"]);
  assert.equal(db.getDocument("unfiled").folder, "");
  assert.equal(db.getDocument("filed").folder, "f1");
});
