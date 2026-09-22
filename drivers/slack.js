const session = require("../session");
const primitives = require("../primitives");
const transport = require("../transport");

// Read-only by default. Agents should never post/send/edit unless explicitly opted in.
const READONLY_METHODS = new Set([
  "api.test",
  "auth.test",
  "conversations.history",
  "conversations.replies",
  "conversations.list",
  "conversations.info",
  "conversations.members",
  "search.messages",
  "search.users",
  "search.files",
  "users.info",
  "users.list",
  "users.lookupByEmail",
  "users.conversations",
  "teams.info",
  "team.info",
]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureApiMeta(client) {
  const existing = await primitives.eval(client, "window.__cdpkit_slack_apiMeta", { returnByValue: true }).catch(() => null);
  if (existing && existing.apiBase) return existing;

  await transport.enable(client, "Network");

  // Close any open modal/overlay, then open the quick switcher to force a live API call.
  await transport.call(client, "Runtime", "evaluate", {
    expression: "document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}))",
    returnByValue: true,
  });
  await sleep(500);

  const meta = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("Network.requestWillBeSent", onRequest);
      reject(new Error("timeout waiting for Slack API metadata"));
    }, 5000);

    function onRequest(params) {
      const url = params.request && params.request.url;
      if (!url || !url.includes("/api/")) return;
      try {
        const u = new URL(url);
        if (!u.host.endsWith(".slack.com") || u.host.startsWith("edgeapi.")) return;
        const versionTs = u.searchParams.get("_x_version_ts");
        const teamId = (u.searchParams.get("slack_route") || "").split(":")[0];
        if (!versionTs || !teamId) return;
        clearTimeout(timer);
        client.off("Network.requestWillBeSent", onRequest);
        resolve({ apiBase: u.origin, versionTs, teamId });
      } catch (e) {}
    }

    client.on("Network.requestWillBeSent", onRequest);

    transport
      .call(client, "Runtime", "evaluate", {
        expression: "window.desktopDelegate.startSearch()",
        awaitPromise: true,
        returnByValue: true,
      })
      .catch(reject);
  });

  await primitives.eval(
    client,
    `window.__cdpkit_slack_apiMeta = ${JSON.stringify(meta)}; document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape', bubbles:true}));`,
    { returnByValue: true }
  );
  return meta;
}

async function slack({ port = 9228, forceRelaunch = false } = {}) {
  const s = await session.start("slack", { port, forceRelaunch });
  await ensureApiMeta(s.client);
  return s;
}

async function emergencyStop(s) {
  await session.emergencyStop(s);
}

async function getCurrentUser(client) {
  return primitives.eval(
    client,
    `(async function(){
      return {
        id: await window.desktopDelegate.getCurrentUserId(),
        name: await window.desktopDelegate.getCurrentUserName(),
        enterprise: await window.desktopDelegate.getEnterpriseId(),
      };
    })()`,
    { returnByValue: true, awaitPromise: true }
  );
}

async function getCurrentView(client) {
  return primitives.eval(
    client,
    `(function(){
      const parts = location.pathname.split('/').filter(Boolean);
      const url = location.href;
      if (parts[0] === 'canvas') return { type: 'canvas', teamId: parts[1], id: parts[2], threadId: null, url };
      if (parts[0] === 'docs') return { type: 'doc', teamId: parts[1], id: parts[2], threadId: null, url };
      if (parts[0] !== 'client' || parts.length < 2) return { type: 'unknown', teamId: null, id: null, threadId: null, url };

      const teamId = parts[1];
      const id = parts[2] || null;
      if (!id || ['home', 'activity', 'search', 'saved', 'files', 'dms', 'more'].includes(id)) {
        return { type: id || 'home', teamId, id: null, threadId: null, url };
      }

      const viewTypes = { C: 'channel', D: 'dm', G: 'group', U: 'user' };
      const idType = viewTypes[id[0]] || 'unknown';

      if (parts[3] === 'thread') {
        return { type: 'thread', teamId, id, threadId: parts[5] || parts[4] || null, url };
      }
      return { type: idType, teamId, id, threadId: null, url };
    })()`,
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

async function getVisibleText(client) {
  return primitives.eval(
    client,
    `(function(){
      const el = document.querySelector('[data-qa="message_list"]') || document.querySelector('.p-message_pane') || document.body;
      return el ? el.innerText : '';
    })()`,
    { returnByValue: true }
  );
}

async function apiCall(client, method, params = {}, { allowWrite = false } = {}) {
  if (!allowWrite && !READONLY_METHODS.has(method)) {
    throw new Error(
      `Slack API method "${method}" is not read-only. Pass { allowWrite: true } only if you explicitly intend to mutate Slack state.`
    );
  }

  const paramEntries = Object.entries(params);
  const paramCode = paramEntries
    .map(([k]) => `form.append(${JSON.stringify(k)}, ${JSON.stringify(params[k])});`)
    .join("\n      ");

  const result = await primitives.eval(
    client,
    `
    (async function(){
      const meta = window.__cdpkit_slack_apiMeta;
      if (!meta) throw new Error('Slack API metadata not initialized');
      const token = await window.desktopDelegate.getTokenForCurrentTeam();
      const form = new FormData();
      form.append('token', token);
      ${paramCode}
      const rid = Math.random().toString(16).slice(2, 10) + '-' + (Date.now() / 1000).toFixed(3);
      const url = new URL(meta.apiBase + '/api/${method}');
      url.searchParams.set('_x_id', rid);
      url.searchParams.set('slack_route', meta.teamId + ':' + meta.teamId);
      url.searchParams.set('_x_version_ts', meta.versionTs);
      url.searchParams.set('_x_foreground', 'true');
      url.searchParams.set('_x_frontend_build_type', 'current');
      url.searchParams.set('_x_desktop_ia', '4');
      url.searchParams.set('_x_gantry', 'true');
      url.searchParams.set('fp', 'ee');
      url.searchParams.set('_x_num_retries', '0');
      const res = await fetch(url.toString(), { method: 'POST', credentials: 'include', body: form });
      return await res.json();
    })()
    `,
    { returnByValue: true, awaitPromise: true }
  );

  if (result && result.ok === false) {
    throw new Error(`Slack API ${method} failed: ${result.error || JSON.stringify(result)}`);
  }
  return result;
}

async function getMessages(client, channelId, { limit = 20, oldest = "0" } = {}) {
  return apiCall(client, "conversations.history", {
    channel: channelId,
    limit,
    oldest,
    ignore_replies: "true",
    include_pin_count: "true",
    inclusive: "true",
    no_user_profile: "true",
    include_stories: "true",
    include_free_team_extra_messages: "true",
    include_date_joined: "true",
  });
}

async function getThreadReplies(client, channelId, threadId, { limit = 50 } = {}) {
  return apiCall(client, "conversations.replies", {
    channel: channelId,
    ts: threadId,
    limit,
    ignore_replies: "false",
    inclusive: "true",
    no_user_profile: "true",
  });
}

async function getChannelsFromDOM(client) {
  return primitives.eval(
    client,
    `(() => {
      const list = [];
      document.querySelectorAll('[data-qa-channel-sidebar-channel-id]').forEach((el) => {
        const id = el.getAttribute('data-qa-channel-sidebar-channel-id');
        const type = el.getAttribute('data-qa-channel-sidebar-channel-type') || 'channel';
        const nameEl = el.querySelector('.p-channel_sidebar__name');
        const name = nameEl ? nameEl.innerText : null;
        list.push({ id, name, type });
      });
      return list;
    })()`,
    { returnByValue: true }
  );
}

async function getChannels(client, { limit = 200, types = "public_channel,private_channel,mpim,im" } = {}) {
  try {
    const res = await apiCall(client, "conversations.list", { limit, types });
    return res.channels || [];
  } catch (err) {
    if (err.message && err.message.includes("enterprise_is_restricted")) {
      return getChannelsFromDOM(client);
    }
    throw err;
  }
}

async function searchMessages(client, query, { count = 20 } = {}) {
  return apiCall(client, "search.messages", { query, count });
}

async function getContext(client) {
  const [user, view, selectedText, visibleText, screenshot] = await Promise.all([
    getCurrentUser(client),
    getCurrentView(client),
    getSelectedText(client),
    getVisibleText(client),
    primitives.captureScreenshot(client),
  ]);
  return {
    app: "slack",
    currentUser: user,
    currentView: view,
    selectedText,
    visibleText,
    screenshot,
  };
}

slack.emergencyStop = emergencyStop;
slack.getCurrentUser = getCurrentUser;
slack.getCurrentView = getCurrentView;
slack.getMessages = getMessages;
slack.getThreadReplies = getThreadReplies;
slack.getChannels = getChannels;
slack.searchMessages = searchMessages;
slack.getContext = getContext;
slack.apiCall = apiCall;

module.exports = slack;
