const session = require("../session");
const primitives = require("../primitives");
const db = require("../db");

const BATCH_SIZE = 50; // API rejects >50 document_ids with a 400
const RATE_LIMIT_INTERVAL = 500;
const SYNC_STALE_MS = 10 * 60 * 1000; // resync local DB if older than 10 minutes

let lastCall = 0;
let queue = Promise.resolve();

function withRateLimit(fn) {
  const p = queue.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, lastCall + RATE_LIMIT_INTERVAL - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = p.catch(() => {});
  return p;
}

function _apiCall(client, endpoint, body, { workspaceId } = {}) {
  return primitives.eval(
    client,
    `(async function(){
      const token = await window.electron.getRefreshedAccessToken();
      const deviceId = await window.electron.getDeviceId();
      const bridge = window.electron.bridge;
      const osVersion = window.electron.osVersion;
      const platform = window.electron.platform;
      const platformHeader = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : platform === 'linux' ? 'Linux' : (platform || 'macOS');
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'X-Client-Version': bridge.shellVersion || '7.503.0',
        'X-Granola-Platform': platformHeader,
        'X-Granola-Device-Id': deviceId,
        'X-Granola-Os-Version': osVersion || ''
      };
      ${workspaceId ? `headers['X-Granola-Workspace-Id'] = ${JSON.stringify(workspaceId)};` : ""}
      const res = await fetch('https://api.granola.ai/v1/' + ${JSON.stringify(endpoint)}, {
        method: 'POST',
        headers,
        body: JSON.stringify(${JSON.stringify(body)})
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(${JSON.stringify(endpoint)} + ' ' + res.status + ': ' + text.slice(0, 500));
      }
      try { return JSON.parse(text); } catch { return text; }
    })()`,
    { returnByValue: true, awaitPromise: true }
  );
}

function apiCall(client, endpoint, body, { workspaceId } = {}) {
  return withRateLimit(() => _apiCall(client, endpoint, body, { workspaceId }));
}

async function getDocumentListIds(client, { folder, maxDocs = null } = {}) {
  return primitives.eval(
    client,
    `(async function(){
      const c = await window.electron.getCache();
      const b = c.buffer;
      let s = '';
      let i = 0;
      while (b[i] !== undefined) { s += String.fromCharCode(b[i]); i++; }
      const maxDocs = ${maxDocs === null ? 'null' : JSON.stringify(maxDocs)};
      const obj = JSON.parse(s);
      const lists = obj.documentLists || {};
      const meta = obj.documentListsMetadata || {};
      const workspaceId = Object.values(meta)[0]?.workspace_id || '';
      const folders = Object.entries(meta).map(([id, m]) => ({ id, title: m.title }));
      let ids = [];
      let documentLists = {};
      if (${JSON.stringify(folder || null)}) {
        const q = ${JSON.stringify((folder || "").toLowerCase())};
        const fid = Object.keys(meta).find(k => k === ${JSON.stringify(folder || "")} || (meta[k].title || '').toLowerCase() === q) || ${JSON.stringify(folder || "")};
        ids = lists[fid] || [];
        documentLists = { [fid]: ids };
      } else {
        const seen = new Set();
        const listsArr = Object.values(lists);
        let idx = 0;
        while (true) {
          let found = false;
          for (const arr of listsArr) {
            if (idx < arr.length && !seen.has(arr[idx])) {
              seen.add(arr[idx]);
              ids.push(arr[idx]);
              found = true;
            }
          }
          if (!found) break;
          idx++;
        }
        documentLists = lists;
      }
      const total = ids.length;
      if (maxDocs !== null && maxDocs !== undefined) ids = ids.slice(0, maxDocs);
      return { workspaceId, ids, documentLists, folders, total };
    })()`,
    { returnByValue: true, awaitPromise: true }
  );
}

async function getDocumentsBatch(client, ids, workspaceId) {
  if (!ids.length) return [];
  const data = await apiCall(client, "get-documents-batch", { document_ids: ids }, { workspaceId });
  return data.docs || [];
}

async function getDocumentTranscript(client, documentId, workspaceId) {
  const data = await apiCall(client, "get-document-transcript", { document_id: documentId }, { workspaceId });
  if (!Array.isArray(data)) return [];
  return data.map((seg) => ({
    start: seg.start_timestamp,
    end: seg.end_timestamp,
    text: seg.text,
    speaker: seg.detected_speaker_name || null,
  }));
}

async function start({ port = 9231, kill = false } = {}) {
  const s = await session.start("granola", {
    port,
    kill,
    target: (t) => t.url && t.url.startsWith("app://ui"),
  });
  return s;
}

async function stop(s) {
  await session.stop(s);
}

async function getCurrentPage(client) {
  const href = await primitives.eval(client, "location.href", { returnByValue: true });
  const title = await primitives.eval(client, "document.title", { returnByValue: true });
  return { title, url: href };
}

async function getText(client) {
  return primitives.eval(
    client,
    `(() => document.body ? document.body.innerText : '')()`,
    { returnByValue: true }
  );
}

async function getSelectedText(client) {
  return primitives.eval(
    client,
    `(() => window.getSelection ? window.getSelection().toString() : '')()`,
    { returnByValue: true }
  );
}

async function getContext(client) {
  const [page, selectedText, visibleText, screenshot] = await Promise.all([
    getCurrentPage(client),
    getSelectedText(client),
    getText(client),
    primitives.captureScreenshot(client),
  ]);
  return {
    app: "granola",
    currentPage: page,
    selectedText,
    visibleText,
    screenshot,
  };
}

async function fetchDocumentListSummaries(client, listId, workspaceId) {
  const summaries = [];
  let offset = 0;
  while (true) {
    const data = await apiCall(client, "get-document-list", { list_id: listId, limit: 1000, offset }, { workspaceId });
    const docs = data.documents || [];
    if (!docs.length) break;
    for (const d of docs) {
      summaries.push({ id: d.id, updated_at: d.updated_at });
    }
    if (docs.length < 1000) break;
    offset += 1000;
  }
  return summaries;
}

async function syncDocuments(client) {
  const { workspaceId, documentLists, folders } = await getDocumentListIds(client, { maxDocs: null });
  const now = Date.now();
  const lastSync = db.getLastSyncedAt();
  let fetched = 0;
  let unchanged = 0;
  if (!lastSync) {
    // Initial/catch-up sync: the DB is empty or a previous initial sync was interrupted.
    // Use the cache's document IDs directly; skip the per-folder list-summary calls.
    const syncedIds = db.getAllDocumentIds();
    for (const folderId of Object.keys(documentLists)) {
      const missing = documentLists[folderId].filter((id) => !syncedIds.has(id));
      for (let i = 0; i < missing.length; i += BATCH_SIZE) {
        const batch = missing.slice(i, i + BATCH_SIZE);
        const docs = await getDocumentsBatch(client, batch, workspaceId);
        db.upsertDocuments(docs, folderId);
        fetched += docs.length;
        if (fetched % 500 === 0) console.log(`synced ${fetched} documents...`);
      }
    }
  } else {
    // Incremental sync: use get-document-list to find changed/removed documents.
    for (const folderId of Object.keys(documentLists)) {
      const summaries = await fetchDocumentListSummaries(client, folderId, workspaceId);
      const currentIds = new Set(summaries.map((s) => s.id));
      const localIds = db.getDocumentIdsForFolder(folderId);
      for (const id of localIds) {
        if (!currentIds.has(id)) db.deleteDocument(id);
      }
      const toFetch = [];
      for (const s of summaries) {
        const existing = db.getDocument(s.id);
        if (!existing || existing.updated_at !== s.updated_at) {
          toFetch.push(s.id);
        } else {
          unchanged++;
        }
      }
      for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
        const batch = toFetch.slice(i, i + BATCH_SIZE);
        const docs = await getDocumentsBatch(client, batch, workspaceId);
        db.upsertDocuments(docs, folderId);
        fetched += docs.length;
        if (fetched % 500 === 0) console.log(`synced ${fetched} documents...`);
      }
    }
  }
  db.setLastSyncedAt(now);
  console.log(`sync complete: ${fetched} fetched, ${unchanged} unchanged`);
  return { fetched, unchanged, folders: folders.length, syncedAt: now };
}

async function searchLocal(client, query, { folder, limit = 100 } = {}) {
  const lastSync = db.getLastSyncedAt();
  const now = Date.now();
  if (!lastSync || now - lastSync > SYNC_STALE_MS) {
    await syncDocuments(client);
  }
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { results: [], total: 0, syncedAt: db.getLastSyncedAt() };
  const rows = db.searchDocuments(terms, { folder, limit });
  const total = db.countDocuments(terms, { folder });
  const results = rows.map((r) => ({
    id: r.id,
    title: r.title || "",
    createdAt: r.created_at,
    url: `app://ui/#/meeting/${r.id}`,
    snippet: (r.notes_plain || r.title || "").slice(0, 200),
    folder: r.folder,
  }));
  return { results, total, syncedAt: db.getLastSyncedAt(), folder };
}

async function getNote(client, documentId) {
  const docs = await getDocumentsBatch(client, [documentId]);
  if (!docs.length) return null;
  const doc = docs[0];
  return {
    id: doc.id,
    title: doc.title || "",
    createdAt: doc.created_at,
    notesPlain: doc.notes_plain,
    notesMarkdown: doc.notes_markdown,
    overview: doc.overview,
    people: doc.people || [],
    url: `app://ui/#/meeting/${doc.id}`,
  };
}

async function getRecentCalls(client, { limit = 10, folder } = {}) {
  const { workspaceId, ids } = await getDocumentListIds(client, { folder, maxDocs: limit * 2 });
  const docs = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = await getDocumentsBatch(client, ids.slice(i, i + BATCH_SIZE), workspaceId);
    docs.push(...batch);
  }
  docs.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return docs.slice(0, limit).map((doc) => ({
    id: doc.id,
    title: doc.title || "",
    createdAt: doc.created_at,
    url: `app://ui/#/meeting/${doc.id}`,
  }));
}

async function getTranscript(client, meetingId) {
  const segs = await getDocumentTranscript(client, meetingId);
  const text = segs.map((s) => s.text).join("\n");
  return {
    meetingId,
    transcript: text,
    segments: segs,
  };
}

module.exports = {
  start,
  stop,
  getCurrentPage,
  getText,
  getSelectedText,
  getContext,
  syncDocuments,
  searchLocal,
  getNote,
  getRecentCalls,
  getTranscript,
};
