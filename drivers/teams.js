const crypto = require("node:crypto");
const { apps } = require("../apps");
const session = require("../session");
const transport = require("../transport");
const primitives = require("../primitives");

const TEAMS_HOSTS = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);

function isTeamsPage(target) {
  if (target.type !== "page") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "https:" && TEAMS_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function listTargets({ port = apps.teams.defaultPort } = {}) {
  const targets = await transport.listTargets("127.0.0.1", port);
  return targets.filter(isTeamsPage);
}

async function teams({ port = apps.teams.defaultPort, target } = {}) {
  let candidates = await listTargets({ port });
  if (target) candidates = candidates.filter(page => transport.findTarget([page], target));
  if (!candidates.length) {
    throw Object.assign(new Error("No matching Teams desktop page. Open Teams with teamsstart and check teams.listTargets()."), {
      code: "TEAMS_TARGET_MISSING",
    });
  }

  if (!target) {
    const ready = [];
    for (const page of candidates) {
      const { client } = await transport.connect({ host: "127.0.0.1", port, target: { id: page.id } });
      try {
        const state = await primitives.eval(client, "({ ready: !!(document.body && document.body.innerText.trim()), focused: document.hasFocus() })");
        if (state.ready) ready.push({ page, focused: state.focused });
      } finally {
        await transport.close(client);
      }
    }
    if (!ready.length) {
      throw Object.assign(new Error("Teams desktop is still loading or has no populated window. Retry after it loads, or pass an explicit target ID."), {
        code: "TEAMS_TARGET_NOT_READY",
      });
    }
    const focused = ready.filter(item => item.focused);
    candidates = (focused.length ? focused : ready).map(item => item.page);
  }

  if (candidates.length !== 1) {
    throw Object.assign(new Error(`Multiple Teams desktop pages match. Pass target: { id: "..." } from teams.listTargets(). IDs: ${candidates.map(page => page.id).join(", ")}`), {
      code: "TEAMS_TARGET_AMBIGUOUS",
    });
  }
  return session.attach({ host: "127.0.0.1", port, target: { id: candidates[0].id } });
}

async function getTitle(client) {
  return primitives.eval(client, "document.title");
}

const CURRENT_VIEW = `(() => {
  const q = (s) => typeof document.querySelector === "function" ? document.querySelector(s) : null;
  const compose = q("[data-track-thread-id]");
  const title = q('[data-tid="chat-title"]');
  return {
    conversationId: compose ? compose.getAttribute("data-track-thread-id") : null,
    title: title ? title.innerText.split("\\n")[0].trim() : null,
  };
})()`;

async function getCurrentView(client) {
  return primitives.eval(client, CURRENT_VIEW);
}

async function getContext(client) {
  return primitives.eval(client, `({
    app: "teams",
    title: document.title,
    url: location.href,
    currentView: ${CURRENT_VIEW},
    text: document.body ? document.body.innerText : ""
  })`);
}

// Minimal GraphQL parser for the documents this driver sends: one operation with variables,
// fields, aliases, arguments, nested selections, and inline fragments. Teams' own parser is not
// reachable from the page, so documents are parsed here and sent to Teams as AST.
function parseGql(src) {
  const toks = src.match(/\.\.\.|[{}():!$,=[\]@]|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*/g) || [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => {
    if (i >= toks.length) throw new Error("GraphQL parse: unexpected end of document");
    return toks[i++];
  };
  const expect = (t) => {
    if (toks[i] !== t) throw new Error(`GraphQL parse: expected ${t} but got ${toks[i] ?? "end of document"}`);
    i++;
  };
  const name = () => {
    const t = next();
    if (!/^[A-Za-z_]/.test(t)) throw new Error(`GraphQL parse: expected a name but got ${t}`);
    return { kind: "Name", value: t };
  };
  const skipCommas = () => { while (peek() === ",") i++; };
  const type = () => {
    let t;
    if (peek() === "[") { next(); t = { kind: "ListType", type: type() }; expect("]"); } else t = { kind: "NamedType", name: name() };
    if (peek() === "!") { next(); t = { kind: "NonNullType", type: t }; }
    return t;
  };
  const value = () => {
    const t = next();
    if (t === "$") return { kind: "Variable", name: name() };
    if (t[0] === '"') return { kind: "StringValue", value: JSON.parse(t) };
    if (/^-?\d+$/.test(t)) return { kind: "IntValue", value: t };
    if (/^-?\d/.test(t)) return { kind: "FloatValue", value: t };
    if (t === "true" || t === "false") return { kind: "BooleanValue", value: t === "true" };
    if (t === "null") return { kind: "NullValue" };
    if (t === "[") {
      const values = [];
      while (peek() !== "]") { values.push(value()); skipCommas(); }
      next();
      return { kind: "ListValue", values };
    }
    if (t === "{") {
      const fields = [];
      while (peek() !== "}") { const n = name(); expect(":"); fields.push({ kind: "ObjectField", name: n, value: value() }); skipCommas(); }
      next();
      return { kind: "ObjectValue", fields };
    }
    return { kind: "EnumValue", value: t };
  };
  const args = () => {
    const out = [];
    if (peek() !== "(") return out;
    next();
    while (peek() !== ")") { const n = name(); expect(":"); out.push({ kind: "Argument", name: n, value: value() }); skipCommas(); }
    next();
    return out;
  };
  const selectionSet = () => {
    expect("{");
    const selections = [];
    while (peek() !== "}") {
      if (peek() === "...") {
        next();
        if (next() !== "on") throw new Error("GraphQL parse: only inline fragments (... on Type) are supported");
        selections.push({ kind: "InlineFragment", typeCondition: { kind: "NamedType", name: name() }, directives: [], selectionSet: selectionSet() });
      } else {
        let alias;
        let n = name();
        if (peek() === ":") { next(); alias = n; n = name(); }
        const field = { kind: "Field", alias, name: n, arguments: args(), directives: [] };
        if (peek() === "{") field.selectionSet = selectionSet();
        selections.push(field);
      }
      skipCommas();
    }
    next();
    return { kind: "SelectionSet", selections };
  };
  const operation = next();
  if (!["query", "mutation", "subscription"].includes(operation)) throw new Error("GraphQL parse: document must start with a named query");
  const opName = name();
  const variableDefinitions = [];
  if (peek() === "(") {
    next();
    while (peek() !== ")") {
      expect("$");
      const variable = { kind: "Variable", name: name() };
      expect(":");
      variableDefinitions.push({ kind: "VariableDefinition", variable, type: type(), directives: [] });
      skipCommas();
    }
    next();
  }
  const set = selectionSet();
  if (i !== toks.length) throw new Error(`GraphQL parse: unexpected ${toks[i]} after the operation`);
  return { kind: "Document", definitions: [{ kind: "OperationDefinition", operation, name: opName, variableDefinitions, directives: [], selectionSet: set }] };
}

// Finds the GraphQL client Teams' own UI uses. Queries go through Teams' link chain to its data
// worker, which handles authentication and network calls; only results return over CDP.
const CLIENT_KEY = "__cdpkitTeamsGraphQLClient";
const FIND_CLIENT = `(() => {
  const cached = window.${CLIENT_KEY};
  if (cached) return cached;
  // Teams has several Apollo clients (view-schema, service-local, main). The main client is the one
  // shared with the most components, so pick the most-referenced candidate.
  const isClient = (v) => v && typeof v.query === "function" && v.queryManager && v.link;
  const counts = new Map();
  const probe = (v, depth, seen) => {
    if (!v || typeof v !== "object" || seen.has(v) || depth > 3) return;
    seen.add(v);
    try {
      if (isClient(v)) { counts.set(v, (counts.get(v) || 0) + 1); return; }
      for (const key of ["_client", "client", "dataClient"]) probe(v[key], depth + 1, seen);
    } catch {}
  };
  for (const el of document.querySelectorAll("body, body *")) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactContainer$"));
    if (!key) continue;
    const stack = [el[key]];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber) continue;
      const props = fiber.memoizedProps;
      if (props && typeof props === "object") for (const v of Object.values(props)) probe(v, 0, new Set());
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [c, n] of counts) if (n > bestCount) { best = c; bestCount = n; }
  return best ? (window.${CLIENT_KEY} = best) : null;
})()`;

function teamsError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Read-only: only query operations are accepted. Mutations and subscriptions are rejected.
async function gqlQuery(client, query, variables = {}, { timeout = 60000 } = {}) {
  const doc = parseGql(query);
  const op = doc.definitions[0].operation;
  if (op !== "query") {
    throw teamsError(`Teams GraphQL ${op} operations are not allowed. The Teams driver is read-only.`, "TEAMS_READ_ONLY");
  }
  const result = await primitives.eval(client, `(async () => {
    const client = ${FIND_CLIENT};
    if (!client) return { missing: true };
    const id = () => crypto.randomUUID();
    const run = client.query({
      query: ${JSON.stringify(doc)},
      variables: ${JSON.stringify(variables)},
      fetchPolicy: "no-cache",
      errorPolicy: "all",
      context: { callerInfo: "cdpkit", callerScenarioId: id() + "@" + id() },
    }).then(
      (r) => ({ data: r.data ?? null, errors: (r.errors || []).map((e) => String(e.message)) }),
      (e) => ({ data: null, errors: [String((e && e.message) || e)] })
    );
    const timer = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ${Number(timeout)}));
    return Promise.race([run, timer]);
  })()`, { awaitPromise: true });
  if (result.missing) {
    throw teamsError("Teams GraphQL client not found in the page. Teams may still be loading, or its internals changed.", "TEAMS_CLIENT_MISSING");
  }
  if (result.timedOut) throw teamsError(`Teams GraphQL query timed out after ${timeout}ms`, "TEAMS_GRAPHQL_TIMEOUT");
  if (result.errors.length) {
    const message = result.errors.map(e => (e.length > 400 ? `${e.slice(0, 400)}…` : e)).join("; ");
    throw teamsError(`Teams GraphQL query failed: ${message}`, "TEAMS_GRAPHQL_ERROR", { errors: result.errors, data: result.data });
  }
  return result.data;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Membership/call events and call recording or transcript cards carry no chat text.
function isSystemMessage(type) {
  return /^(ThreadActivity|Event)\/|^RichText\/Media_Call/.test(type || "");
}

const MESSAGE_FIELDS = "id messageType content imDisplayName fromUserId originalArrivalTime editTime deleteTime translationStatus sourceLanguageCode";

function toMessage(m, conversationId) {
  return {
    id: m.id,
    conversationId,
    time: m.originalArrivalTime,
    from: m.imDisplayName || null,
    fromUserId: m.fromUserId || null,
    type: m.messageType,
    system: isSystemMessage(m.messageType),
    edited: m.editTime || null,
    deleted: m.deleteTime || null,
    // Set when the user translated the message in Teams; Teams then returns the translation as content.
    translatedFrom: m.translationStatus === "Done" ? m.sourceLanguageCode || "unknown" : null,
    text: isSystemMessage(m.messageType) ? "" : htmlToText(m.content),
    html: m.content,
  };
}

const MESSAGES_QUERY = `query CdpkitTeamsMessages($convId: ID!, $replyChainId: String, $count: Int, $cursor: MessagesCursorInput) {
  messages(convId: $convId, replyChainId: $replyChainId, count: $count, cursor: $cursor) {
    messages { ${MESSAGE_FIELDS} }
    cursor { value source }
  }
}`;

// Messages newest first. Pages backwards through history until `limit`, `since`, or the start of
// the conversation. Teams serves synced history from its local store and fetches the rest itself.
async function getMessages(client, conversationId, { limit = 50, since, cursor, replyChainId, includeSystem = false, pageSize = 50 } = {}) {
  const sinceMs = since ? new Date(since).getTime() : null;
  const messages = [];
  let next = cursor || null;
  let hasMore = true;
  while (messages.length < limit) {
    const data = await gqlQuery(client, MESSAGES_QUERY, {
      convId: conversationId,
      // Never request more than still needed, so a page is always consumed whole and Teams' cursor stays exact.
      count: Math.min(pageSize, limit - messages.length),
      ...(replyChainId ? { replyChainId } : {}),
      ...(next ? { cursor: next } : {}),
    });
    const page = (data && data.messages) || {};
    const batch = page.messages || [];
    let reachedSince = false;
    for (const raw of batch) {
      const m = toMessage(raw, conversationId);
      if (sinceMs !== null && new Date(m.time).getTime() < sinceMs) { reachedSince = true; break; }
      if (!includeSystem && m.system) continue;
      messages.push(m);
    }
    const nextCursor = page.cursor && page.cursor.value ? { value: page.cursor.value, source: page.cursor.source } : null;
    const stalled = !batch.length || !nextCursor || (next && nextCursor.value === next.value);
    next = nextCursor;
    if (reachedSince || stalled) { hasMore = !reachedSince && !stalled; break; }
  }
  return { messages, nextCursor: hasMore ? next : null, hasMore };
}

async function getThreadReplies(client, conversationId, replyChainId, options = {}) {
  return getMessages(client, conversationId, { ...options, replyChainId });
}

const CHATS_QUERY = `query CdpkitTeamsChats($first: Int, $after: String) {
  chats(first: $first, after: $after) {
    pageInfo { endCursor hasNextPage }
    edges { node { id title isOneOnOne isMeeting lastContentMessageTime lastMessage { imDisplayName preview originalArrivalTime } } }
  }
}`;

async function getConversations(client, { limit = 50 } = {}) {
  const out = [];
  let after = null;
  while (out.length < limit) {
    const data = await gqlQuery(client, CHATS_QUERY, { first: Math.min(50, limit - out.length), ...(after ? { after } : {}) });
    const chats = data.chats;
    for (const { node } of chats.edges) {
      const last = node.lastMessage || {};
      out.push({
        id: node.id,
        title: node.title || (node.id === "48:notes" ? "Notes (self chat)" : null),
        type: node.isMeeting ? "meeting" : node.isOneOnOne ? "oneOnOne" : node.id.startsWith("48:") ? "self" : "group",
        lastMessageTime: node.lastContentMessageTime || last.originalArrivalTime || null,
        lastMessage: last.originalArrivalTime ? { from: last.imDisplayName || null, preview: last.preview || null, time: last.originalArrivalTime } : null,
      });
    }
    if (!chats.pageInfo.hasNextPage || !chats.pageInfo.endCursor || chats.pageInfo.endCursor === after) break;
    after = chats.pageInfo.endCursor;
  }
  return out;
}

const CHANNELS_QUERY = `query CdpkitTeamsChannels {
  joinedTeamsAndChannels(activitiesFromWorker: false) { joinedTeams { id displayName isArchived channels { id displayName isGeneral isUserMember } } }
}`;

async function getChannels(client) {
  const data = await gqlQuery(client, CHANNELS_QUERY);
  return (data.joinedTeamsAndChannels.joinedTeams || []).map(team => ({
    id: team.id,
    name: team.displayName,
    archived: !!team.isArchived,
    channels: team.channels.map(c => ({ id: c.id, name: c.displayName, general: !!c.isGeneral, member: c.isUserMember !== false })),
  }));
}

const REPLY_CHAINS_QUERY = `query CdpkitTeamsReplyChains($conversationId: ID!, $first: Int, $after: String) {
  replyChains(conversationId: $conversationId, first: $first, after: $after) {
    pageInfo { endCursor hasNextPage }
    edges { node { id originalArrivalTime } }
  }
}`;

// Channel threads, newest first. Use each replyChainId with getThreadReplies.
async function getReplyChains(client, channelId, { limit = 20 } = {}) {
  const out = [];
  let after = null;
  while (out.length < limit) {
    const data = await gqlQuery(client, REPLY_CHAINS_QUERY, { conversationId: channelId, first: Math.min(50, limit - out.length), ...(after ? { after } : {}) });
    const chains = data.replyChains;
    for (const { node } of chains.edges) {
      out.push({ id: node.id, replyChainId: String(node.id).split("::").pop(), time: new Date(Number(node.originalArrivalTime)).toISOString() });
    }
    if (!chains.pageInfo.hasNextPage || !chains.pageInfo.endCursor || chains.pageInfo.endCursor === after) break;
    after = chains.pageInfo.endCursor;
  }
  return out.slice(0, limit);
}

const MEMBERS_QUERY = `query CdpkitTeamsMembers($convId: ID!) {
  chatMembers(convId: $convId) { members { id displayName email userPrincipalName tenantId } }
}`;

async function getMembers(client, conversationId) {
  const data = await gqlQuery(client, MEMBERS_QUERY, { convId: conversationId });
  return ((data.chatMembers && data.chatMembers.members) || []).map(m => ({
    id: m.id, name: m.displayName || null, email: m.email || m.userPrincipalName || null, tenantId: m.tenantId || null,
  }));
}

// The built-in Notes self chat always has exactly one member: the signed-in user.
async function getCurrentUser(client) {
  const [me] = await getMembers(client, "48:notes");
  if (!me) throw teamsError("Could not resolve the signed-in Teams user.", "TEAMS_USER_MISSING");
  return me;
}

const SEARCH_QUERY = `query CdpkitTeamsSearch($searchTerm: String!, $telemetryInfo: SearchTelemetryInfo!, $searchContext: SearchRequestContext!) {
  searchResults(searchTerm: $searchTerm, telemetryInfo: $telemetryInfo, searchContext: $searchContext) {
    searchStatus
    groups { moreResultsAvailable results { ... on SearchItem { id title { text } subTitles { text type } thumbnail { displayName mri } primaryAction { navigationId } } } }
  }
}`;

// Server-side message search across all chats and channels, run by Teams' worker. Teams returns
// 25 results per zero-based page, most relevant first; use hasMore to decide whether to page.
async function searchMessages(client, query, { page = 0 } = {}) {
  const data = await gqlQuery(client, SEARCH_QUERY, {
    searchTerm: query,
    // Teams' search backend requires a fresh session ID per search in this field.
    telemetryInfo: { caller: "SERP", conversationId: crypto.randomUUID() },
    searchContext: { scopes: [{ source: "SUBSTRATEQUERY", entityList: ["MESSAGE"] }], pageNumber: page },
  });
  const r = data.searchResults;
  if (r.searchStatus !== "REMOTE_SEARCH_SUCCESS" && r.searchStatus !== "REMOTE_RESULTS_EMPTY") {
    throw teamsError(`Teams search failed: ${r.searchStatus}`, "TEAMS_SEARCH_FAILED", { status: r.searchStatus });
  }
  const groups = r.groups || [];
  const results = groups.flatMap(g => g.results || []).filter(Boolean).map(item => {
    const fields = {};
    for (const s of item.subTitles || []) if (s.type && !(s.type in fields)) fields[s.type] = s.text;
    return {
      id: item.id,
      messageId: (item.primaryAction && item.primaryAction.navigationId) || null,
      conversationId: fields.ClientConversationId || fields.ClientThreadId || null,
      replyChainId: fields.SkypeSpaces_ConversationPost_Extension_ParentMessageId || null,
      channel: fields.ChannelName || null,
      team: fields.TeamName || null,
      time: fields.DateTimeSent || null,
      from: (item.thumbnail && item.thumbnail.displayName) || null,
      fromUserId: (item.thumbnail && item.thumbnail.mri) || null,
      text: htmlToText(item.title && item.title.text),
      fields,
    };
  });
  return { results, page, hasMore: groups.some(g => g.moreResultsAvailable) };
}

teams.listTargets = listTargets;
teams.getTitle = getTitle;
teams.getText = primitives.getText;
teams.getContext = getContext;
teams.getCurrentUser = getCurrentUser;
teams.getCurrentView = getCurrentView;
teams.getConversations = getConversations;
teams.getChannels = getChannels;
teams.getMessages = getMessages;
teams.getThreadReplies = getThreadReplies;
teams.getReplyChains = getReplyChains;
teams.getMembers = getMembers;
teams.searchMessages = searchMessages;
teams.gqlQuery = gqlQuery;
teams.parseGql = parseGql;
teams.htmlToText = htmlToText;

module.exports = teams;
