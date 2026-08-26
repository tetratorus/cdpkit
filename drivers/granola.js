const session = require("../session");
const primitives = require("../primitives");
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const BATCH_SIZE = 50; // API rejects >50 document_ids with a 400
const RATE_LIMIT_INTERVAL = 500;
const SEARCH_STATE_DIR = path.resolve(__dirname, "..", ".search-state");

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
      if (${JSON.stringify(folder || null)}) {
        const q = ${JSON.stringify((folder || "").toLowerCase())};
        const fid = Object.keys(meta).find(k => k === ${JSON.stringify(folder || "")} || (meta[k].title || '').toLowerCase() === q) || ${JSON.stringify(folder || "")};
        ids = lists[fid] || [];
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
      }
      const total = ids.length;
      if (maxDocs !== null && maxDocs !== undefined) ids = ids.slice(0, maxDocs);
      return { workspaceId, ids, folders, total, listsMeta: meta };
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

function personName(p) {
  return p?.name || p?.details?.person?.name?.fullName || p?.details?.person?.name?.givenName || "";
}

function haystackFor(doc) {
  const parts = [];
  if (doc.title) parts.push(doc.title);
  if (doc.notes_plain) parts.push(doc.notes_plain);
  if (doc.notes_markdown) parts.push(doc.notes_markdown);
  if (doc.overview) parts.push(doc.overview);
  if (doc.summary) parts.push(doc.summary);
  if (doc.google_calendar_event?.summary) parts.push(doc.google_calendar_event.summary);
  if (doc.people?.creator) {
    parts.push(personName(doc.people.creator));
    if (doc.people.creator.email) parts.push(doc.people.creator.email);
  }
  if (Array.isArray(doc.people?.attendees)) {
    for (const p of doc.people.attendees) {
      parts.push(personName(p));
      if (p.email) parts.push(p.email);
    }
  }
  return parts.join("\n").toLowerCase();
}

async function checkCacheFreshness(client, { folder } = {}) {
  const { workspaceId, listsMeta } = await getDocumentListIds(client, { folder });
  const lists = [];
  let fresh = true;
  for (const [listId, m] of Object.entries(listsMeta)) {
    try {
      const server = await apiCall(client, "get-document-list", { list_id: listId }, { workspaceId });
      const cacheUpdatedAt = m.updated_at;
      const serverUpdatedAt = server.updated_at;
      const listFresh = cacheUpdatedAt === serverUpdatedAt;
      if (!listFresh) fresh = false;
      lists.push({ listId, title: server.title || m.title || "", cacheUpdatedAt, serverUpdatedAt, fresh: listFresh });
    } catch (err) {
      fresh = false;
      lists.push({ listId, title: m.title || "", error: err.message });
    }
  }
  return { fresh, lists };
}

function statePath(token) {
  return path.join(SEARCH_STATE_DIR, `${token}.json`);
}

async function loadSearchState(token) {
  const data = await fs.readFile(statePath(token), "utf8");
  return JSON.parse(data);
}

async function saveSearchState(token, state) {
  await fs.mkdir(SEARCH_STATE_DIR, { recursive: true });
  await fs.writeFile(statePath(token), JSON.stringify(state), "utf8");
}

async function deleteSearchState(token) {
  try {
    await fs.unlink(statePath(token));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function search(client, query, { folder, resume } = {}) {
  let state;
  if (resume) {
    state = await loadSearchState(resume);
  } else {
    if (!query) throw new Error("query is required");
    const { workspaceId, ids, total } = await getDocumentListIds(client, { folder });
    state = { query, folder, workspaceId, ids, total, offset: 0 };
  }
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    if (resume) await deleteSearchState(resume);
    return { results: [], total: state.total, searched: 0, progressPercentage: 0, resume: null };
  }
  const { workspaceId, ids, total, offset } = state;
  if (offset >= ids.length) {
    if (resume) await deleteSearchState(resume);
    return { results: [], total, searched: total, progressPercentage: 100, resume: null };
  }
  const batch = ids.slice(offset, offset + BATCH_SIZE);
  const newOffset = offset + batch.length;
  const docs = await getDocumentsBatch(client, batch, workspaceId);
  const results = [];
  for (const doc of docs) {
    const haystack = haystackFor(doc);
    if (!terms.every((t) => haystack.includes(t))) continue;
    const snippet = (doc.notes_plain || doc.notes_markdown || doc.title || "").slice(0, 200);
    results.push({
      id: doc.id,
      title: doc.title || "",
      createdAt: doc.created_at,
      url: `app://ui/#/meeting/${doc.id}`,
      snippet,
    });
  }
  const searched = newOffset;
  const progressPercentage = total ? Math.round((searched / total) * 10000) / 100 : 0;
  const nextResume = newOffset < total ? (resume || crypto.randomBytes(5).toString("hex")) : null;
  if (nextResume) {
    state.offset = newOffset;
    await saveSearchState(nextResume, state);
  } else if (resume) {
    await deleteSearchState(resume);
  }
  return { results, total, searched, progressPercentage, resume: nextResume };
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
  search,
  checkCacheFreshness,
  getNote,
  getRecentCalls,
  getTranscript,
};
