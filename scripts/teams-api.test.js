const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const vm = require("node:vm");
const { Server } = createRequire(require.resolve("chrome-remote-interface"))("ws");
const teams = require("../drivers/teams");
const state = require("../state");
const transport = require("../transport");

const UUID = /^[0-9a-f-]{36}$/;

// Fake Teams page: Runtime.evaluate runs in a VM whose window holds a fake Teams GraphQL client.
// Handlers are keyed by operation name and return { data, errors } like Apollo with errorPolicy "all".
async function teamsApi(t, handlers = {}, { withClient = true, dom = {} } = {}) {
  t.mock.method(state, "setLastWorking", () => {});
  t.mock.method(state, "setLastFailure", () => {});
  const requests = [];
  const evaluations = [];
  const fakeClient = {
    query: async (vmOptions) => {
      const options = JSON.parse(JSON.stringify(vmOptions));
      requests.push(options);
      const handler = handlers[options.query.definitions[0].name.value];
      return handler ? handler(options.variables, options) : { data: null, errors: [{ message: "no handler" }] };
    },
  };
  const evaluate = (expression) => {
    evaluations.push(expression);
    const sandbox = {
      document: {
        title: "Teams",
        body: { innerText: "Visible Teams content" },
        hasFocus: () => true,
        querySelector: (s) => dom[s] || null,
        querySelectorAll: () => [],
      },
      location: { href: "https://teams.microsoft.com/v2/" },
      crypto: { randomUUID: () => crypto.randomUUID() },
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
    };
    sandbox.window = sandbox;
    if (withClient) sandbox.__cdpkitTeamsGraphQLClient = fakeClient;
    return vm.runInNewContext(expression, sandbox);
  };
  const protocol = { domains: [{ domain: "Runtime", commands: [{ name: "evaluate" }] }] };
  let port;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/json/protocol" ? protocol : [{
      id: "main", type: "page", title: "Teams", url: "https://teams.microsoft.com/v2/",
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/main`,
    }]));
  });
  const wss = new Server({ server });
  wss.on("connection", (ws) => {
    ws.on("message", async (data) => {
      const message = JSON.parse(data);
      const value = await evaluate(message.params.expression);
      ws.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const s = await teams({ port, target: { id: "main" } });
  t.after(async () => {
    await transport.close(s.client);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  return { client: s.client, requests, evaluations };
}

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const history = Array.from({ length: 12 }, (_, i) => ({
  id: String(T0 - i * 60000),
  messageType: i === 3 ? "ThreadActivity/AddMember" : i === 5 ? "RichText/Media_CallRecording" : "RichText/Html",
  content: i === 3 ? "<addmember>…</addmember>" : `<p>Message ${i} &amp; more</p>`,
  imDisplayName: i === 3 ? "" : `Person ${i % 2}`,
  fromUserId: `8:orgid:${i % 2}`,
  originalArrivalTime: new Date(T0 - i * 60000).toISOString(),
  editTime: null,
  deleteTime: null,
  translationStatus: i === 1 ? "Done" : null,
  sourceLanguageCode: i === 1 ? "th" : "en",
}));

// Mirrors Teams: newest first, cursor is the exclusive arrival time of the oldest returned message.
function messagesHandler({ count, cursor }) {
  const older = history.filter(m => !cursor || Date.parse(m.originalArrivalTime) < Number(cursor.value));
  const batch = older.slice(0, count);
  const done = older.length <= count;
  return {
    data: {
      messages: {
        messages: batch,
        cursor: done ? null : { value: String(Date.parse(batch.at(-1).originalArrivalTime)), source: "CHAT_MESSAGES" },
      },
    },
  };
}

test("parseGql builds a GraphQL AST for variables, aliases, arguments, and inline fragments", () => {
  const doc = teams.parseGql(`query Q($id: ID!, $ids: [String!], $n: Int) {
    a: node(id: $id, first: 5, flag: true, kind: CHAT, input: { list: [1, "x"], none: null }) {
      id, ... on Chat { title }
    }
  }`);
  const op = doc.definitions[0];
  assert.equal(op.operation, "query");
  assert.equal(op.name.value, "Q");
  assert.deepEqual(op.variableDefinitions.map(v => v.variable.name.value), ["id", "ids", "n"]);
  assert.deepEqual(op.variableDefinitions[1].type, {
    kind: "ListType", type: { kind: "NonNullType", type: { kind: "NamedType", name: { kind: "Name", value: "String" } } },
  });
  const field = op.selectionSet.selections[0];
  assert.equal(field.alias.value, "a");
  assert.equal(field.name.value, "node");
  assert.deepEqual(field.arguments.map(a => [a.name.value, a.value.kind]), [
    ["id", "Variable"], ["first", "IntValue"], ["flag", "BooleanValue"], ["kind", "EnumValue"], ["input", "ObjectValue"],
  ]);
  assert.deepEqual(field.arguments[4].value.fields.map(f => f.value.kind), ["ListValue", "NullValue"]);
  assert.equal(field.selectionSet.selections[1].kind, "InlineFragment");
  assert.equal(field.selectionSet.selections[1].typeCondition.name.value, "Chat");
});

test("parseGql rejects malformed or unsupported documents", () => {
  assert.throws(() => teams.parseGql("{ me { id } }"), /named query/);
  assert.throws(() => teams.parseGql("query Q { me { id }"), /unexpected end|expected/);
  assert.throws(() => teams.parseGql("query Q { me { id } } extra"), /after the operation/);
  assert.throws(() => teams.parseGql("query Q { me { ...Frag } }"), /inline fragments/);
});

test("Teams GraphQL is read-only: mutations and subscriptions never reach the page", async (t) => {
  const f = await teamsApi(t);
  const before = f.evaluations.length;
  for (const doc of ["mutation M { sendMessage(text: \"hi\") { id } }", "subscription S { typing { id } }"]) {
    await assert.rejects(teams.gqlQuery(f.client, doc), { code: "TEAMS_READ_ONLY" });
  }
  assert.equal(f.evaluations.length, before);
  assert.equal(f.requests.length, 0);
});

test("Teams queries run through the in-page client uncached with a Teams scenario context", async (t) => {
  const f = await teamsApi(t, { Probe: () => ({ data: { ok: true } }) });
  assert.deepEqual(await teams.gqlQuery(f.client, "query Probe($x: Int) { ok(x: $x) }", { x: 1 }), { ok: true });
  const [req] = f.requests;
  assert.equal(req.fetchPolicy, "no-cache");
  assert.equal(req.errorPolicy, "all");
  assert.deepEqual(req.variables, { x: 1 });
  assert.equal(req.context.callerInfo, "cdpkit");
  const [correlationId, logicalId] = req.context.callerScenarioId.split("@");
  assert.match(correlationId, UUID);
  assert.match(logicalId, UUID);
  assert.ok(f.evaluations.every(e => !/fetch\(|XMLHttpRequest|authorization|token/i.test(e)));
});

test("Teams GraphQL errors and a missing client fail loudly", async (t) => {
  const f = await teamsApi(t, { Bad: () => ({ data: null, errors: [{ message: "Resolver for Query.bad is missing" }] }) });
  await assert.rejects(teams.gqlQuery(f.client, "query Bad { bad }"), (err) => {
    assert.equal(err.code, "TEAMS_GRAPHQL_ERROR");
    assert.deepEqual(err.errors, ["Resolver for Query.bad is missing"]);
    return true;
  });
  const g = await teamsApi(t, {}, { withClient: false });
  await assert.rejects(teams.gqlQuery(g.client, "query Probe { ok }"), { code: "TEAMS_CLIENT_MISSING" });
});

test("getMessages pages back through history, skips system events, and resumes without gaps", async (t) => {
  const f = await teamsApi(t, { CdpkitTeamsMessages: messagesHandler });
  const conv = "19:abc@thread.v2";
  const first = await teams.getMessages(f.client, conv, { limit: 5, pageSize: 4 });
  assert.equal(first.messages.length, 5);
  assert.equal(first.hasMore, true);
  assert.ok(first.messages.every(m => !m.system));
  assert.deepEqual(first.messages[0], {
    id: history[0].id, conversationId: conv, time: history[0].originalArrivalTime, from: "Person 0",
    fromUserId: "8:orgid:0", type: "RichText/Html", system: false, edited: null, deleted: null, translatedFrom: null,
    text: "Message 0 & more", html: history[0].content,
  });
  const rest = await teams.getMessages(f.client, conv, { limit: 100, pageSize: 4, cursor: first.nextCursor });
  assert.equal(rest.hasMore, false);
  assert.equal(rest.nextCursor, null);
  const expected = history.filter((_, i) => i !== 3 && i !== 5).map(m => m.id);
  assert.deepEqual([...first.messages, ...rest.messages].map(m => m.id), expected);
  assert.equal(f.requests[0].variables.convId, conv);
  assert.equal(f.requests[0].variables.count, 4);
  assert.equal("cursor" in f.requests[0].variables, false);

  const all = await teams.getMessages(f.client, conv, { limit: 100, includeSystem: true });
  assert.equal(all.messages.length, history.length);
  assert.equal(all.messages[3].system, true);
  assert.equal(all.messages[3].text, "");
  assert.equal(all.messages[5].system, true);
  assert.equal(all.messages[1].translatedFrom, "th");
});

test("getMessages stops at since and getThreadReplies passes the reply chain", async (t) => {
  const f = await teamsApi(t, { CdpkitTeamsMessages: messagesHandler });
  const since = history[6].originalArrivalTime;
  const r = await teams.getMessages(f.client, "19:abc@thread.v2", { since, pageSize: 4 });
  assert.deepEqual(r.messages.map(m => m.id), history.slice(0, 7).filter((_, i) => i !== 3 && i !== 5).map(m => m.id));
  assert.equal(r.hasMore, false);
  await teams.getThreadReplies(f.client, "19:chan@thread.tacv2", "1700000000000", { limit: 1 });
  assert.equal(f.requests.at(-1).variables.replyChainId, "1700000000000");
});

test("getConversations maps chats and follows pagination", async (t) => {
  const pages = {
    "": { edges: [{ node: { id: "19:a@thread.v2", title: "Group", isOneOnOne: false, isMeeting: false, lastContentMessageTime: "2026-01-02T00:00:00Z", lastMessage: { imDisplayName: "Ann", preview: "Hi", originalArrivalTime: "2026-01-02T00:00:00Z" } } }], pageInfo: { endCursor: "c1", hasNextPage: true } },
    c1: { edges: [{ node: { id: "19:meeting_x@thread.v2", title: "Sync", isOneOnOne: false, isMeeting: true, lastContentMessageTime: null, lastMessage: { imDisplayName: null, preview: "Recording is ready", originalArrivalTime: "2026-01-01T00:00:00Z" } } }, { node: { id: "48:notes", title: "", isOneOnOne: false, isMeeting: false, lastContentMessageTime: null, lastMessage: null } }], pageInfo: { endCursor: "c2", hasNextPage: false } },
  };
  const f = await teamsApi(t, { CdpkitTeamsChats: ({ after }) => ({ data: { chats: pages[after || ""] } }) });
  assert.deepEqual(await teams.getConversations(f.client), [
    { id: "19:a@thread.v2", title: "Group", type: "group", lastMessageTime: "2026-01-02T00:00:00Z", lastMessage: { from: "Ann", preview: "Hi", time: "2026-01-02T00:00:00Z" } },
    { id: "19:meeting_x@thread.v2", title: "Sync", type: "meeting", lastMessageTime: "2026-01-01T00:00:00Z", lastMessage: { from: null, preview: "Recording is ready", time: "2026-01-01T00:00:00Z" } },
    { id: "48:notes", title: "Notes (self chat)", type: "self", lastMessageTime: null, lastMessage: null },
  ]);
  assert.deepEqual(f.requests.map(r => r.variables.after), [undefined, "c1"]);
});

test("channel, reply-chain, member, and current-user helpers map Teams results", async (t) => {
  const f = await teamsApi(t, {
    CdpkitTeamsChannels: () => ({ data: { joinedTeamsAndChannels: { joinedTeams: [{ id: "19:team@thread.tacv2", displayName: "Team", isArchived: false, channels: [{ id: "19:gen@thread.tacv2", displayName: "General", isGeneral: true, isUserMember: true }] }] } } }),
    CdpkitTeamsReplyChains: () => ({ data: { replyChains: { pageInfo: { endCursor: null, hasNextPage: false }, edges: [{ node: { id: "19:gen@thread.tacv2::1700000000000", originalArrivalTime: 1700000000000 } }] } } }),
    CdpkitTeamsMembers: ({ convId }) => ({ data: { chatMembers: { members: [{ id: `8:orgid:${convId === "48:notes" ? "me" : "other"}`, displayName: "Name", email: null, userPrincipalName: "name@example.com", tenantId: null }] } } }),
  });
  assert.deepEqual(await teams.getChannels(f.client), [
    { id: "19:team@thread.tacv2", name: "Team", archived: false, channels: [{ id: "19:gen@thread.tacv2", name: "General", general: true, member: true }] },
  ]);
  assert.deepEqual(await teams.getReplyChains(f.client, "19:gen@thread.tacv2"), [
    { id: "19:gen@thread.tacv2::1700000000000", replyChainId: "1700000000000", time: new Date(1700000000000).toISOString() },
  ]);
  assert.deepEqual(await teams.getCurrentUser(f.client), { id: "8:orgid:me", name: "Name", email: "name@example.com", tenantId: null });
});

test("searchMessages uses a fresh search session and maps results", async (t) => {
  const f = await teamsApi(t, {
    CdpkitTeamsSearch: () => ({
      data: {
        searchResults: {
          searchStatus: "REMOTE_SEARCH_SUCCESS",
          groups: [{
            moreResultsAvailable: true,
            results: [{
              id: "exchange-id",
              title: { text: "<p>Shall we have a call?</p>" },
              subTitles: [
                { text: "2026-01-01T00:00:00Z", type: "DateTimeSent" },
                { text: "19:chan@thread.tacv2", type: "ClientConversationId" },
                { text: "General", type: "ChannelName" },
                { text: "Team", type: "TeamName" },
                { text: "1700000000000", type: "SkypeSpaces_ConversationPost_Extension_ParentMessageId" },
              ],
              thumbnail: { displayName: "Ann", mri: "8:orgid:ann" },
              primaryAction: { navigationId: "1700000000999" },
            }, null],
          }],
        },
      },
    }),
  });
  const r = await teams.searchMessages(f.client, "call", { page: 2 });
  assert.equal(r.hasMore, true);
  assert.equal(r.page, 2);
  const { fields, ...result } = r.results[0];
  assert.deepEqual(result, {
    id: "exchange-id", messageId: "1700000000999", conversationId: "19:chan@thread.tacv2", replyChainId: "1700000000000",
    channel: "General", team: "Team", time: "2026-01-01T00:00:00Z", from: "Ann", fromUserId: "8:orgid:ann", text: "Shall we have a call?",
  });
  assert.equal(fields.ChannelName, "General");
  assert.equal(r.results.length, 1);
  await teams.searchMessages(f.client, "call");
  const [a, b] = f.requests.map(req => req.variables);
  assert.equal(a.searchTerm, "call");
  assert.equal(a.searchContext.pageNumber, 2);
  assert.deepEqual(a.searchContext.scopes, [{ source: "SUBSTRATEQUERY", entityList: ["MESSAGE"] }]);
  assert.match(a.telemetryInfo.conversationId, UUID);
  assert.notEqual(a.telemetryInfo.conversationId, b.telemetryInfo.conversationId);
});

test("searchMessages reports failed searches instead of returning nothing", async (t) => {
  const f = await teamsApi(t, { CdpkitTeamsSearch: () => ({ data: { searchResults: { searchStatus: "REMOTE_SEARCH_FAILED", groups: [] } } }) });
  await assert.rejects(teams.searchMessages(f.client, "x"), { code: "TEAMS_SEARCH_FAILED", status: "REMOTE_SEARCH_FAILED" });
});

test("getCurrentView reads the open conversation from the page", async (t) => {
  const f = await teamsApi(t, {}, {
    dom: {
      "[data-track-thread-id]": { getAttribute: () => "19:open@thread.v2" },
      '[data-tid="chat-title"]': { innerText: "Project chat\nExternal" },
    },
  });
  assert.deepEqual(await teams.getCurrentView(f.client), { conversationId: "19:open@thread.v2", title: "Project chat" });
});

test("htmlToText strips markup and decodes entities", () => {
  assert.equal(teams.htmlToText('<p>A &amp; B<br>C</p><p><span itemtype="http://schema.skype.com/Mention">Ann</span> &#x1F600; &#39;x&#39;&nbsp;</p>'), "A & B\nC\nAnn 😀 'x'");
  assert.equal(teams.htmlToText(null), "");
});
