const session = require("../session");
const transport = require("../transport");
const primitives = require("../primitives");
const observation = require("../observation");

async function start({ port = 9229, kill = false, url } = {}) {
  const s = await session.start("chrome", { port, kill });
  if (url) {
    await navigate(s.client, url);
  }
  return s;
}

async function stop(s) {
  await session.stop(s);
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

async function screenshot(client, opts) {
  return observation.captureScreenshot(client, opts);
}

async function run(client, expression) {
  return primitives.eval(client, expression);
}

module.exports = {
  start,
  stop,
  navigate,
  getTitle,
  getText,
  screenshot,
  run,
};
