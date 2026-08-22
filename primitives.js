const transport = require("./transport");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function unwrapResult(res) {
  if (res.exceptionDetails) {
    const text = res.exceptionDetails.exception
      ? res.exceptionDetails.exception.description || res.exceptionDetails.text
      : res.exceptionDetails.text;
    throw new Error(`Runtime exception: ${text}`);
  }
  if (res.result && "value" in res.result) return res.result.value;
  return res.result;
}

async function eval(client, expression, { returnByValue = true, awaitPromise = false } = {}) {
  const res = await transport.call(client, "Runtime", "evaluate", {
    expression,
    returnByValue,
    awaitPromise,
  });
  return unwrapResult(res);
}

async function getText(client) {
  return eval(client, "document.body ? document.body.innerText : ''", { returnByValue: true });
}

async function getHtml(client) {
  return eval(client, "document.documentElement ? document.documentElement.outerHTML : ''", {
    returnByValue: true,
  });
}

async function query(client, selector) {
  const res = await eval(client, `document.querySelector(${JSON.stringify(selector)}) !== null`, {
    returnByValue: true,
  });
  return res;
}

async function click(client, selector) {
  return eval(client, `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('element not found: ' + ${JSON.stringify(selector)});
    el.click();
    return true;
  })()`, { returnByValue: true });
}

async function type(client, selector, text) {
  return eval(client, `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('element not found: ' + ${JSON.stringify(selector)});
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, { returnByValue: true });
}

async function waitFor(client, expression, { timeout = 30000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await eval(client, `(function(){ try { return !!( ${expression} ); } catch(e) { return false; } })()`, {
      returnByValue: true,
    });
    if (ok) return true;
    await sleep(interval);
  }
  throw new Error(`waitFor timed out after ${timeout}ms: ${expression}`);
}

async function waitForSelector(client, selector, opts) {
  return waitFor(client, `document.querySelector(${JSON.stringify(selector)})`, opts);
}

async function captureScreenshot(client, { fullPage = false } = {}) {
  await require("./transport").enable(client, "Page");
  const metrics = await require("./transport").call(client, "Page", "getLayoutMetrics");
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport;
  const content = metrics.cssContentSize || metrics.contentSize;
  const clip = fullPage
    ? {
        x: 0,
        y: 0,
        width: content.width,
        height: content.height,
        scale: 1,
      }
    : {
        x: viewport.pageX,
        y: viewport.pageY,
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        scale: 1,
      };
  const res = await require("./transport").call(client, "Page", "captureScreenshot", { format: "png", fromSurface: true, clip });
  return res.data;
}

module.exports = {
  eval,
  getText,
  getHtml,
  query,
  click,
  type,
  waitFor,
  waitForSelector,
  captureScreenshot,
};
