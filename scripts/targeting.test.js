const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const { createRequire } = require("node:module");
const { test } = require("node:test");
const vm = require("node:vm");
const { Server } = createRequire(require.resolve("chrome-remote-interface"))("ws");
const chrome = require("../drivers/chrome");
const teams = require("../drivers/teams");
const { apps } = require("../apps");
const session = require("../session");
const transport = require("../transport");
const state = require("../state");

async function fixture(t, evaluate = (_expression, target) => target) {
  t.mock.method(state, "setLastWorking", () => {});
  t.mock.method(state, "setLastFailure", () => {});
  const calls = [];
  const connections = [];
  let targets = [];
  const protocol = {
    domains: [
      { domain: "Runtime", commands: [{ name: "evaluate" }] },
      { domain: "Page", commands: [{ name: "navigate" }], events: [{ name: "loadEventFired" }] },
      { domain: "Test", commands: [{ name: "disconnect" }, { name: "emit" }] },
    ],
  };
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/json/protocol" ? protocol : targets));
  });
  const wss = new Server({ server });
  wss.on("connection", (ws, req) => {
    connections.push(req.url);
    ws.on("message", (data) => {
      const message = JSON.parse(data);
      calls.push({ target: req.url, ...message });
      if (message.method === "Test.disconnect") return ws.close();
      if (message.method === "Test.emit") {
        ws.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 } }));
      }
      const value = message.params.expression === "1+1" ? 2 : evaluate(message.params.expression, req.url);
      const result = message.method === "Runtime.evaluate" ? { result: { value } } : {};
      ws.send(JSON.stringify({ id: message.id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const page = (id, url = "about:blank") => ({
    id, type: "page", title: id, url,
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${id}`,
  });
  targets = [page("first"), page("chosen")];
  const connect = async (options = {}) => {
    const s = await transport.connect({ port, ...options });
    t.after(() => transport.close(s.client));
    return s;
  };
  const disconnect = async (client) => {
    const closed = once(client._ws, "close");
    client._ws.terminate();
    await closed;
  };
  return { port, page, calls, connections, connect, disconnect, setTargets: (value) => { targets = value; } };
}

test("Chrome accepts an explicit target before navigation", async (t) => {
  const f = await fixture(t);
  const s = await chrome({ port: f.port, target: { id: "chosen" }, url: "about:blank#requested" });
  t.after(() => transport.close(s.client));
  assert.equal(s.target.id, "chosen");
  assert.equal(await chrome.getTitle(s.client), "/chosen");
  assert.ok(f.calls.every((call) => call.target === "/chosen"));
});

test("an explicit missing Chrome target never falls back", async (t) => {
  const f = await fixture(t);
  await assert.rejects(chrome({ port: f.port, target: { id: "missing" } }), /No CDP target matched/);
  assert.deepEqual(f.connections, []);
});

test("default selection stays pinned when target order changes", async (t) => {
  const f = await fixture(t);
  const { client } = await f.connect();
  await f.disconnect(client);
  f.setTargets([f.page("chosen"), f.page("first")]);
  assert.equal(await chrome.getTitle(client), "/first");
  assert.deepEqual(f.connections, ["/first", "/first"]);
  assert.equal(client._target.id, "first");
  assert.equal(state.setLastWorking.mock.calls.at(-1).arguments[2].targetId, "first");
});

test("URL selection is resolved once and survives navigation on reconnect", async (t) => {
  const f = await fixture(t);
  f.setTargets([f.page("chosen", "about:blank#original")]);
  const { client } = await f.connect({ target: { url: "#original" } });
  await f.disconnect(client);
  f.setTargets([f.page("replacement", "about:blank#original"), f.page("chosen", "about:blank#navigated")]);
  assert.equal(await chrome.getTitle(client), "/chosen");
  assert.equal(client._target.url, "about:blank#navigated");
  assert.deepEqual(f.connections, ["/chosen", "/chosen"]);
});

test("a missing pinned target does not reselect or restart the app", async (t) => {
  const f = await fixture(t);
  const restart = t.mock.fn(async () => {});
  const { client } = await f.connect({ target: { id: "chosen" }, restart });
  await f.disconnect(client);
  f.setTargets([f.page("replacement")]);
  await assert.rejects(chrome.getTitle(client), { code: "CDP_TARGET_MISSING" });
  assert.equal(restart.mock.callCount(), 0);
  assert.deepEqual(f.connections, ["/chosen"]);
  assert.deepEqual(f.calls, []);
});

test("a disappeared URL match cannot be replaced by another matching tab", async (t) => {
  const f = await fixture(t);
  f.setTargets([f.page("chosen", "about:blank#same")]);
  const { client } = await f.connect({ target: { url: "#same" } });
  await f.disconnect(client);
  f.setTargets([f.page("replacement", "about:blank#same")]);
  await assert.rejects(chrome.getTitle(client), { code: "CDP_TARGET_MISSING" });
  assert.deepEqual(f.connections, ["/chosen"]);
});

test("event handlers survive reconnection to the pinned target", async (t) => {
  const f = await fixture(t);
  const { client } = await f.connect({ target: { id: "chosen" } });
  const onLoad = t.mock.fn();
  client.on("Page.loadEventFired", onLoad);
  await f.disconnect(client);
  await client.Test.emit();
  assert.equal(onLoad.mock.callCount(), 1);
  assert.deepEqual(onLoad.mock.calls[0].arguments[0], { timestamp: 1 });
});

test("a command interrupted by disconnection is never replayed", async (t) => {
  const f = await fixture(t);
  const restart = t.mock.fn(async () => {});
  const { client } = await f.connect({ target: { id: "chosen" }, restart });
  await assert.rejects(client.Test.disconnect());
  assert.equal(f.calls.filter((call) => call.method === "Test.disconnect").length, 1);
  assert.equal(restart.mock.callCount(), 0);
  assert.deepEqual(f.connections, ["/chosen"]);
});

async function teamsFixture(t, pages) {
  const f = await fixture(t, (expression, target) => {
    const page = pages.find(p => `/${p.id}` === target);
    return vm.runInNewContext(expression, {
      document: {
        title: page.title || page.id,
        body: page.noBody ? null : { innerText: page.text ?? "Visible Teams content" },
        hasFocus: () => page.focused || false,
      },
      location: { href: page.url || "https://teams.microsoft.com/v2/" },
    });
  });
  f.setTargets(pages.map(p => ({
    ...f.page(p.id, p.url || "https://teams.microsoft.com/v2/"),
    title: p.title || p.id,
    type: p.type || "page",
  })));
  return f;
}

test("Teams selects the populated desktop page, not empty views or workers", async (t) => {
  const f = await teamsFixture(t, [
    { id: "blank", text: "" },
    { id: "worker", type: "service_worker" },
    { id: "other", url: "https://example.com/" },
    { id: "main", title: "Teams chat" },
  ]);
  const s = await teams({ port: f.port });
  t.after(() => transport.close(s.client));
  assert.equal(s.target.id, "main");
  assert.equal(s.ownsProcess, false);
  assert.deepEqual(f.connections, ["/blank", "/main", "/main"]);
  assert.equal(await teams.getTitle(s.client), "Teams chat");
});

test("Teams prefers a focused populated page when several views have content", async (t) => {
  const f = await teamsFixture(t, [
    { id: "background" },
    { id: "focused", focused: true },
  ]);
  const s = await teams({ port: f.port });
  t.after(() => transport.close(s.client));
  assert.equal(s.target.id, "focused");
});

test("Teams ignores focus on an empty background page", async (t) => {
  const f = await teamsFixture(t, [{ id: "blank", text: "", focused: true }, { id: "main" }]);
  const s = await teams({ port: f.port });
  t.after(() => transport.close(s.client));
  assert.equal(s.target.id, "main");
});

test("Teams rejects ambiguous explicit URL selectors without probing pages", async (t) => {
  const f = await teamsFixture(t, [{ id: "first" }, { id: "second" }]);
  await assert.rejects(teams({ port: f.port, target: { url: "teams.microsoft.com" } }), { code: "TEAMS_TARGET_AMBIGUOUS" });
  assert.deepEqual(f.connections, []);
});

test("Teams rejects ambiguous populated pages instead of picking an account", async (t) => {
  const f = await teamsFixture(t, [{ id: "first" }, { id: "second" }]);
  await assert.rejects(teams({ port: f.port }), { code: "TEAMS_TARGET_AMBIGUOUS" });
  assert.deepEqual(f.connections, ["/first", "/second"]);
});

test("Teams rejects multiple focused populated pages", async (t) => {
  const f = await teamsFixture(t, [{ id: "first", focused: true }, { id: "second", focused: true }]);
  await assert.rejects(teams({ port: f.port }), { code: "TEAMS_TARGET_AMBIGUOUS" });
});

test("Teams reports loading when all page bodies are absent or empty", async (t) => {
  const f = await teamsFixture(t, [{ id: "blank", text: "  \n" }, { id: "loading", noBody: true }]);
  await assert.rejects(teams({ port: f.port }), { code: "TEAMS_TARGET_NOT_READY" });
});

test("Teams target discovery rejects lookalike hosts, other schemes, and non-page targets", async (t) => {
  const f = await teamsFixture(t, [
    { id: "work" },
    { id: "personal", url: "https://teams.live.com/v2/" },
    { id: "cloud", url: "https://teams.cloud.microsoft/v2/" },
    { id: "suffix", url: "https://teams.microsoft.com.example.com/" },
    { id: "prefix", url: "https://notteams.microsoft.com/" },
    { id: "insecure", url: "http://teams.microsoft.com/" },
    { id: "malformed", url: "not a URL" },
    { id: "iframe", type: "iframe" },
  ]);
  assert.deepEqual((await teams.listTargets({ port: f.port })).map(p => p.id), ["work", "personal", "cloud"]);
  assert.deepEqual(f.connections, []);
});

test("Teams refuses to attach when the endpoint has no Teams pages", async (t) => {
  const f = await teamsFixture(t, [{ id: "unrelated", url: "about:blank" }]);
  await assert.rejects(teams({ port: f.port }), { code: "TEAMS_TARGET_MISSING" });
  assert.deepEqual(f.connections, []);
});

test("an explicit Teams target can select an empty view without probing others", async (t) => {
  const f = await teamsFixture(t, [{ id: "main" }, { id: "blank", text: "" }]);
  const s = await teams({ port: f.port, target: { id: "blank" } });
  t.after(() => transport.close(s.client));
  assert.equal(s.target.id, "blank");
  assert.deepEqual(f.connections, ["/blank"]);
  assert.deepEqual(f.calls, []);
});

test("explicit Teams selection never falls back or selects a foreign page", async (t) => {
  const f = await teamsFixture(t, [{ id: "main" }, { id: "other", url: "https://example.com/" }]);
  for (const id of ["missing", "other"]) {
    await assert.rejects(teams({ port: f.port, target: { id } }), { code: "TEAMS_TARGET_MISSING" });
  }
  assert.deepEqual(f.connections, []);
});

test("Teams context and text helpers only read the selected page", async (t) => {
  const f = await teamsFixture(t, [{ id: "main", title: "Teams chat", text: "Sample visible text" }]);
  const s = await teams({ port: f.port, target: { id: "main" } });
  t.after(() => transport.close(s.client));
  assert.deepEqual(await teams.getContext(s.client), {
    app: "teams", title: "Teams chat", url: "https://teams.microsoft.com/v2/", text: "Sample visible text",
  });
  assert.equal(await teams.getText(s.client), "Sample visible text");
  assert.ok(f.calls.every(call => call.target === "/main" && call.method === "Runtime.evaluate"));
});

test("Teams reconnect stays pinned and never switches to a replacement window", async (t) => {
  const f = await teamsFixture(t, [{ id: "main" }, { id: "background", text: "" }]);
  const s = await teams({ port: f.port });
  t.after(() => transport.close(s.client));
  await f.disconnect(s.client);
  f.setTargets([f.page("background", "https://teams.microsoft.com/v2/"), f.page("main", "https://teams.microsoft.com/v2/")]);
  assert.equal(await teams.getTitle(s.client), "main");
  await f.disconnect(s.client);
  f.setTargets([f.page("background", "https://teams.microsoft.com/v2/")]);
  await assert.rejects(teams.getTitle(s.client), { code: "CDP_TARGET_MISSING" });
});

test("Teams never launches or restarts the desktop app when CDP is unavailable", async (t) => {
  t.mock.method(transport, "listTargets", async () => { throw new Error("ECONNREFUSED"); });
  const start = t.mock.method(session, "start", () => { throw new Error("Unexpected app launch"); });
  await assert.rejects(teams(), /ECONNREFUSED/);
  assert.equal(start.mock.callCount(), 0);
});

test("Teams launcher config passes WebView2 debugging arguments on loopback", () => {
  assert.equal(apps.teams.processName, "MSTeams");
  assert.equal(apps.teams.defaultPort, 9232);
  assert.deepEqual(apps.teams.launchArgs(9232), [
    "/usr/bin/env",
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9232 --remote-debugging-address=127.0.0.1",
    "/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams",
  ]);
});
