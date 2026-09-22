const session = require("../session");
const transport = require("../transport");
const primitives = require("../primitives");

async function chrome({ port = 9229, url, target } = {}) {
  const s = await session.start("chrome", { port, target, allowKill: false });
  if (url) {
    await navigate(s.client, url);
  }
  return s;
}

async function emergencyStop(s) {
  await session.emergencyStop(s);
}

async function navigate(client, url) {
  await transport.call(client, "Page", "navigate", { url });
  await primitives.waitFor(client, "document.readyState === 'complete'", {
    timeout: 30000,
    interval: 100,
  });
}

async function getTitle(client) {
  return primitives.eval(client, "document.title");
}

async function getText(client) {
  return primitives.getText(client);
}

async function run(client, expression) {
  return primitives.eval(client, expression);
}

async function getContext(client) {
  const [title, url, text] = await Promise.all([
    getTitle(client),
    run(client, "location.href"),
    getText(client),
  ]);
  return { app: "chrome", title, url, text };
}

chrome.emergencyStop = emergencyStop;
chrome.navigate = navigate;
chrome.getTitle = getTitle;
chrome.getText = getText;
chrome.run = run;
chrome.getContext = getContext;

module.exports = chrome;
