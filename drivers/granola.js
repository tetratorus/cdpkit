const session = require("../session");
const primitives = require("../primitives");
const db = require("../db");

const BATCH_SIZE = 50; // API rejects >50 document_ids with a 400
const RATE_LIMIT_INTERVAL = 0;
const SYNC_STALE_MS = 60 * 60 * 1000; // resync local DB if older than 1 hour
const MAX_CONCURRENCY = 30;
const FOLDER_CONCURRENCY = 30;
const OWN_DOCS_PAGE_SIZE = 100;

let lastCall = 0;
let active = 0;
const pending = [];

async function processQueue() {
  if (active >= MAX_CONCURRENCY || !pending.length) return;
  active++;
  const { fn, resolve, reject } = pending.shift();
  const now = Date.now();
  const wait = Math.max(0, lastCall + RATE_LIMIT_INTERVAL - now);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  try {
    resolve(await fn());
  } catch (err) {
    reject(err);
  } finally {
    active--;
    processQueue();
  }
}

function withRateLimit(fn) {
  return new Promise((resolve, reject) => {
    pending.push({ fn, resolve, reject });
    processQueue();
  });
}

function runWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;
  let active = 0;
  let failed = false;
  return new Promise((resolve, reject) => {
    function next() {
      if (failed) return;
      if (index === items.length && active === 0) {
        resolve(results);
        return;
      }
      while (active < concurrency && index < items.length) {
        active++;
        const i = index++;
        Promise.resolve(fn(items[i], i)).then((res) => {
          results[i] = res;
          active--;
          next();
        }).catch((err) => {
          if (!failed) {
            failed = true;
            reject(err);
          }
        });
      }
    }
    next();
  });
}

let syncPromise = null;

function _apiCall(client, endpoint, body, { workspaceId, version = "v1" } = {}) {
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
      const res = await fetch('https://api.granola.ai/${version}/' + ${JSON.stringify(endpoint)}, {
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

function apiCall(client, endpoint, body, opts = {}) {
  return withRateLimit(() => _apiCall(client, endpoint, body, opts));
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
      return { workspaceId, ids, documentLists, folders, folderMeta: meta, total };
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

async function fetchDocumentBatches(client, ids, workspaceId, { batchSize = BATCH_SIZE, onProgress } = {}) {
  if (!ids.length) return [];
  const batches = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    batches.push(ids.slice(i, i + batchSize));
  }
  const results = await Promise.all(
    batches.map(async (batch) => {
      const docs = await getDocumentsBatch(client, batch, workspaceId);
      if (onProgress) onProgress(docs.length);
      return docs;
    })
  );
  return results.flat();
}

async function granola({ port = 9231, launch = false } = {}) {
  const s = await session.start("granola", {
    port,
    allowKill: false,
    allowLaunch: launch,
    target: (t) => t.url && t.url.startsWith("app://ui"),
  });
  return s;
}

async function emergencyStop(s) {
  await session.emergencyStop(s);
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
  const data = await apiCall(client, "get-document-list", { list_id: listId, limit: 1000000, offset: 0 }, { workspaceId });
  const docs = data.documents || [];
  return docs.map((d) => ({ id: d.id, updated_at: d.updated_at }));
}

async function syncDocuments(client) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    try {
      return await _syncDocuments(client);
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

async function _syncDocuments(client) {
  console.log("reading Granola cache...");
  const { workspaceId, documentLists, folders, folderMeta } = await getDocumentListIds(client, { maxDocs: null });
  console.log(`cache read: ${folders.length} folders`);
  const now = Date.now();
  const lastSync = db.getLastSyncedAt();
  const syncedIds = lastSync ? null : db.getAllDocumentIds();

  const stats = { fetched: 0, unchanged: 0, skippedFolders: 0 };
  const folderIds = Object.keys(documentLists);

  await runWithConcurrency(folderIds, FOLDER_CONCURRENCY, async (folderId) => {
    const ids = documentLists[folderId] || [];
    const m = folderMeta[folderId];

    if (lastSync) {
      const serverUpdatedAt = m ? m.updated_at : null;
      const localUpdatedAt = db.getFolderSyncAt(folderId);
      if (serverUpdatedAt && localUpdatedAt && String(serverUpdatedAt) === String(localUpdatedAt)) {
        stats.unchanged += ids.length;
        stats.skippedFolders++;
        return;
      }
      if (serverUpdatedAt && localUpdatedAt === null) {
        db.setFolderSyncAt(folderId, serverUpdatedAt);
        stats.unchanged += ids.length;
        stats.skippedFolders++;
        return;
      }
    }

    let toFetch = [];
    let summaries = null;
    if (lastSync) {
      // get-document-list ignores `limit` and returns full docs, so very large folders 500 server-side.
      summaries = await fetchDocumentListSummaries(client, folderId, workspaceId).catch((err) => {
        console.warn(`get-document-list failed for folder ${m?.title || folderId} (${ids.length} docs), refetching from cache ids: ${err.message}`);
        return null;
      });
    }
    if (!lastSync) {
      toFetch = ids.filter((id) => !syncedIds.has(id));
    } else if (!summaries) {
      const currentIds = new Set(ids);
      const toDelete = db.getDocumentIdsForFolder(folderId).filter((id) => !currentIds.has(id));
      if (toDelete.length) db.deleteDocuments(toDelete);
      toFetch = ids;
    } else {
      const currentIds = new Set(summaries.map((s) => s.id));
      const localIds = db.getDocumentIdsForFolder(folderId);
      const toDelete = localIds.filter((id) => !currentIds.has(id));
      if (toDelete.length) db.deleteDocuments(toDelete);
      for (const s of summaries) {
        const existing = db.getDocument(s.id);
        if (!existing || String(existing.updated_at) !== String(s.updated_at)) {
          toFetch.push(s.id);
        } else {
          stats.unchanged++;
        }
      }
    }

    const docs = await fetchDocumentBatches(client, toFetch, workspaceId, {
      onProgress: (n) => {
        stats.fetched += n;
        if (stats.fetched % 500 === 0) console.log(`synced ${stats.fetched} documents...`);
      },
    });
    db.upsertDocuments(docs, folderId);
    if (m) db.setFolderSyncAt(folderId, m.updated_at);
  });

  stats.fetched += await syncOwnDocuments(client, workspaceId, { full: !lastSync });

  db.setLastSyncedAt(now);
  console.log(`sync complete: ${stats.fetched} fetched, ${stats.unchanged} unchanged, ${stats.skippedFolders} folders skipped`);
  return { fetched: stats.fetched, unchanged: stats.unchanged, skippedFolders: stats.skippedFolders, folders: folders.length, syncedAt: now };
}

// Folder lists only cover filed notes; page the user's own notes (newest first) to pick up unfiled ones.
// Incremental syncs stop at the first page with no new or changed docs.
async function syncOwnDocuments(client, workspaceId, { full = false, pageSize = OWN_DOCS_PAGE_SIZE } = {}) {
  let fetched = 0;
  for (let offset = 0; ; offset += pageSize) {
    const data = await apiCall(client, "get-documents", { limit: pageSize, offset, include_last_viewed_panel: true }, { workspaceId, version: "v2" });
    const docs = data.docs || [];
    if (data.deleted?.length) db.deleteDocuments(data.deleted);
    const changed = docs.filter((d) => {
      const existing = db.getDocument(d.id);
      return !existing || String(existing.updated_at) !== String(d.updated_at);
    });
    db.upsertDocuments(changed, undefined);
    fetched += changed.length;
    if (docs.length < pageSize || (!full && !changed.length)) return fetched;
  }
}

async function ensureSynced(client) {
  const lastSync = db.getLastSyncedAt();
  const now = Date.now();
  if (!lastSync || now - lastSync > SYNC_STALE_MS) {
    await syncDocuments(client);
  }
}

async function searchLocal(client, query, { folder, limit = 100 } = {}) {
  await ensureSynced(client);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { results: [], total: 0, syncedAt: db.getLastSyncedAt() };
  const rows = db.searchDocuments(terms, { folder, limit });
  const total = db.countDocuments(terms, { folder });
  const results = rows.map((r) => ({
    id: r.id,
    title: r.title || "",
    createdAt: r.created_at,
    url: `app://ui/#/meeting/${r.id}`,
    snippet: (r.notes_plain || r.panel_text || r.title || "").slice(0, 200),
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
  await ensureSynced(client);
  const { workspaceId, ids } = await getDocumentListIds(client, { folder, maxDocs: limit * 2 });
  const docs = await fetchDocumentBatches(client, ids, workspaceId);
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

granola.emergencyStop = emergencyStop;
granola.getCurrentPage = getCurrentPage;
granola.getText = getText;
granola.getSelectedText = getSelectedText;
granola.getContext = getContext;
granola.syncDocuments = syncDocuments;
granola.searchLocal = searchLocal;
granola.getNote = getNote;
granola.getRecentCalls = getRecentCalls;
granola.getTranscript = getTranscript;

module.exports = granola;
