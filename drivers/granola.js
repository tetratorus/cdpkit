const session = require("../session");
const primitives = require("../primitives");
const transport = require("../transport");

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

async function search(client, query, { limit = 20 } = {}) {
  // Placeholder: Granola search requires UI automation or the companion CLI.
  // With CDP we can inspect the DOM and interact, but a full search implementation
  // depends on the current route.
  throw new Error("Granola search via CDP is not yet implemented. Use the UI or the companion CLI.");
}

module.exports = {
  start,
  stop,
  getCurrentPage,
  getText,
  getSelectedText,
  getContext,
  search,
};
