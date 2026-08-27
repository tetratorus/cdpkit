const session = require("../session");
const primitives = require("../primitives");
const transport = require("../transport");

// Read-only by default.
const READONLY_METHODS = new Set([
  "getSpacesInitial",
  "getPublicPageData",
  "syncRecordValuesSpaceInitial",
  "syncRecordValuesMain",
  "loadPageChunk",
  "syncPageRecordSinceTimestamp",
  "getUserSharedPagesInSpace",
  "getUserSignals",
  "search",
  "isDesktopVersionCompatible",
  "ping",
  "getAppConfig",
  "getPublicSpaceData",
  "getTeamsV2",
  "getIsMailUser",
  "getSpacePermissionGroupIdsContainingMembers",
  "getAIUsageEligibility",
  "getAllSpacePermissionGroupsWithMemberCount",
  "getUnreadInAppMessagesForUser",
  "getUserTasks",
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pageIdNoHyphens(id) {
  return id.replace(/-/g, "");
}

function pageIdWithHyphens(id) {
  const s = id.replace(/-/g, "");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function parseNotionUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split("/"); // /p/<spaceDomain>/<slug-id>
  if (parts.length < 4) return null;
  const spaceDomain = parts[2];
  const tail = parts[3];
  const m = tail.match(/([a-f0-9]{32})$/i);
  const pageId = m ? pageIdWithHyphens(m[1]) : null;
  return { spaceDomain, pageId };
}

async function ensureMeta(client) {
  const parsed = await primitives.eval(client, `(function(){ return JSON.stringify({href: location.href}); })()`, { returnByValue: true });
  const { href } = JSON.parse(parsed);
  const info = parseNotionUrl(href);
  if (!info || !info.pageId) throw new Error("cannot parse Notion page URL: " + href);

  const existing = await primitives.eval(client, "window.__cdpkit_notion_meta", { returnByValue: true }).catch(() => null);
  if (existing && existing.spaceId && existing.pageId === info.pageId) return existing;

  const pageData = await apiCall(client, "getPublicPageData", {
    type: "block-space",
    name: "page",
    blockId: info.pageId,
    spaceDomain: info.spaceDomain,
    requestedOnPublicDomain: false,
    requestedOnAlternateDomain: true,
    showMoveTo: false,
    saveParent: false,
    shouldDuplicate: false,
    projectManagementLaunch: false,
    configureOpenInDesktopApp: false,
    mobileData: { isPush: false },
    demoWorkspaceMode: false,
  });

  const meta = { spaceId: pageData.spaceId, spaceDomain: info.spaceDomain, pageId: info.pageId };
  await primitives.eval(client, `window.__cdpkit_notion_meta = ${JSON.stringify(meta)}`, { returnByValue: true });
  return meta;
}

async function apiCall(client, method, params = {}, { allowWrite = false } = {}) {
  if (!allowWrite && !READONLY_METHODS.has(method)) {
    throw new Error(
      `Notion API method "${method}" is not read-only. Pass { allowWrite: true } only if you explicitly intend to mutate Notion state.`
    );
  }

  const result = await primitives.eval(
    client,
    `
    (async function(){
      const res = await fetch('https://app.notion.com/api/v3/${method}', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: ${JSON.stringify(JSON.stringify(params))},
      });
      return await res.json();
    })()
    `,
    { returnByValue: true, awaitPromise: true }
  );

  if (result && result.isNotionError) {
    throw new Error(`Notion API ${method} failed: ${result.debugMessage || result.message || JSON.stringify(result)}`);
  }
  return result;
}

async function start({ port = 9230, forceRelaunch = false } = {}) {
  const s = await session.start("notion", {
    port,
    forceRelaunch,
    target: (t) => t.url && t.url.includes("app.notion.com/p"),
  });
  await ensureMeta(s.client);
  return s;
}

async function emergencyStop(s) {
  await session.emergencyStop(s);
}

async function getCurrentPage(client) {
  const href = await primitives.eval(client, "location.href", { returnByValue: true });
  const info = parseNotionUrl(href);
  const page = await primitives.eval(client, `({ title: document.title, url: location.href })`, { returnByValue: true });
  page.pageId = info ? info.pageId : null;
  return page;
}

async function getSelectedText(client) {
  return primitives.eval(client, `(() => window.getSelection ? window.getSelection().toString() : '')()`, { returnByValue: true });
}

async function getText(client) {
  return primitives.eval(
    client,
    `(function(){
      const el = document.querySelector('.notion-page-content') || document.querySelector('main') || document.body;
      return el ? el.innerText : '';
    })()`,
    { returnByValue: true }
  );
}

async function search(client, query, { limit = 20 } = {}) {
  const meta = await ensureMeta(client);
  const body = {
    type: "BlocksInSpace",
    query,
    limit,
    source: "quick_find",
    filters: {
      isDeletedOnly: false,
      excludeTemplates: false,
      navigableBlockContentOnly: false,
      requireEditPermissions: false,
      includePublicPagesWithoutExplicitAccess: false,
      ancestors: [],
      createdBy: [],
      editedBy: [],
      lastEditedTime: {},
      createdTime: {},
      inTeams: [],
      excludeSurrogateCollections: false,
      excludedParentCollectionIds: [],
      contentStatusFilter: "all_without_archived",
    },
    sort: { field: "relevance" },
    peopleBlocksToInclude: "all",
    spaceId: meta.spaceId,
    excludedBlockIds: [],
    searchSessionFlowNumber: 1,
    searchSessionId: "00000000-0000-0000-0000-000000000000",
    recentPagesForBoosting: [],
    ignoresHighlight: false,
  };

  const result = await apiCall(client, "search", body);
  return (result.results || []).map((r) => {
    const id = r.id;
    const title = r.highlight && r.highlight.text ? r.highlight.text.replace(/<[^>]+>/g, "") : id;
    const url = `https://app.notion.com/p/${meta.spaceDomain}/${pageIdNoHyphens(id)}`;
    return { id, title, url, score: r.score };
  });
}

async function openPage(client, pageIdOrUrl) {
  const meta = await ensureMeta(client);
  let pageId = pageIdOrUrl;
  if (pageIdOrUrl.includes("/")) {
    const parsed = parseNotionUrl(pageIdOrUrl);
    pageId = parsed ? parsed.pageId : pageIdOrUrl;
  }
  const url = `https://app.notion.com/p/${meta.spaceDomain}/${pageIdNoHyphens(pageId)}`;
  await transport.enable(client, "Page");
  await transport.call(client, "Page", "navigate", { url });
  await sleep(3000);
  return getCurrentPage(client);
}

async function goBack(client) {
  await primitives.eval(client, `window.history.back()`, { returnByValue: true });
  await sleep(1500);
  return getCurrentPage(client);
}

async function goForward(client) {
  await primitives.eval(client, `window.history.forward()`, { returnByValue: true });
  await sleep(1500);
  return getCurrentPage(client);
}

async function loadPage(client, pageId, { maxChunks = 20 } = {}) {
  await ensureMeta(client);
  let cursor = { stack: [] };
  const recordMap = { block: {} };
  let chunkNumber = 0;
  while (chunkNumber < maxChunks) {
    const chunk = await apiCall(client, "loadPageChunk", {
      pageId,
      chunkNumber,
      limit: 100,
      cursor,
      verticalColumns: false,
    });
    const blocks = chunk && chunk.recordMap && chunk.recordMap.block ? chunk.recordMap.block : {};
    Object.assign(recordMap.block, blocks);
    const count = Object.keys(blocks).length;
    if (!chunk.cursor || count === 0) break;
    cursor = chunk.cursor;
    chunkNumber++;
  }
  return recordMap;
}

function blockTitle(block) {
  const val = block.value && block.value.value ? block.value.value : block.value;
  if (val && val.properties && val.properties.title) {
    return val.properties.title
      .map((t) => {
        if (typeof t === "string") return t;
        if (Array.isArray(t)) return t[0] || "";
        return "";
      })
      .join("");
  }
  return "";
}

async function getFullPageText(client, pageId) {
  if (!pageId) {
    const meta = await ensureMeta(client);
    pageId = meta.pageId;
  }
  const recordMap = await loadPage(client, pageId);
  const blocks = recordMap.block;
  const visited = new Set();

  function getText(id, depth = 0) {
    if (visited.has(id)) return "";
    visited.add(id);
    const block = blocks[id];
    if (!block) return "";
    const val = block.value && block.value.value ? block.value.value : block.value;
    let text = "";
    const title = blockTitle(block);
    if (title) text += "  ".repeat(depth) + title + "\n";
    if (val && val.content) {
      for (const childId of val.content) {
        text += getText(childId, depth + 1);
      }
    }
    return text;
  }

  return getText(pageId, 0);
}

async function getContext(client) {
  const [page, selectedText, visibleText, screenshot] = await Promise.all([
    getCurrentPage(client),
    getSelectedText(client),
    getText(client),
    primitives.captureScreenshot(client),
  ]);
  return {
    app: "notion",
    currentPage: page,
    selectedText,
    visibleText,
    screenshot,
  };
}

module.exports = {
  start,
  emergencyStop,
  getCurrentPage,
  getText,
  getFullPageText,
  loadPage,
  search,
  openPage,
  goBack,
  goForward,
  getContext,
  apiCall,
};
