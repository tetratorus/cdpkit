const http = require("http");

const DEFAULT_TIMEOUT_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTargets(host = "127.0.0.1", port = 9222, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const url = `http://${host}:${port}/json/list`;
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    const req = http.get(url, { timeout: timeoutMs, agent }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.socket) res.socket.destroy();
        agent.destroy();
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Failed to parse target list from ${url}: ${err.message}`));
        }
      });
      res.on("error", (err) => {
        if (res.socket) res.socket.destroy();
        agent.destroy();
        reject(err);
      });
    });
    req.on("error", (err) => {
      if (req.socket) req.socket.destroy();
      agent.destroy();
      reject(new Error(`Cannot reach CDP at ${url}: ${err.message}`));
    });
    req.on("timeout", () => {
      req.destroy();
      agent.destroy();
      reject(new Error(`Timeout reaching CDP at ${url}`));
    });
  });
}

async function pingClient(client, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const res = await Promise.race([
    client.Runtime.evaluate({ expression: "1+1", returnByValue: true }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("in-band ping timeout")), timeoutMs)
    ),
  ]);
  if (res && res.result && res.result.value === 2) {
    return { ok: true };
  }
  return { ok: false, error: new Error("ping returned unexpected value") };
}

async function freshSocketProbe({ host = "127.0.0.1", port = 9222, target, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const start = Date.now();
  const targets = await listTargets(host, port, timeoutMs);
  const chosen = target
    ? findTarget(targets, target)
    : targets.find((t) => t.type === "page");
  if (!chosen) {
    throw new Error(`No CDP target matched ${JSON.stringify(target)} on ${host}:${port}`);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(chosen.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`fresh socket probe timed out for ${chosen.id}`));
    }, timeoutMs);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "1+1", returnByValue: true },
        })
      );
    };

    ws.onmessage = (m) => {
      clearTimeout(timer);
      ws.close();
      try {
        const data = JSON.parse(m.data);
        if (data.result && data.result.result && data.result.result.value === 2) {
          resolve({
            ok: true,
            latencyMs: Date.now() - start,
            targetId: chosen.id,
            target: chosen,
          });
        } else {
          resolve({
            ok: false,
            latencyMs: Date.now() - start,
            targetId: chosen.id,
            target: chosen,
            error: new Error("fresh socket probe returned unexpected value"),
          });
        }
      } catch (err) {
        resolve({
          ok: false,
          latencyMs: Date.now() - start,
          targetId: chosen.id,
          target: chosen,
          error: err,
        });
      }
    };

    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`fresh socket probe websocket error: ${e.message || e}`));
    };
  });
}

function findTarget(targets, predicate) {
  if (typeof predicate === "function") {
    return targets.find(predicate);
  }
  if (predicate.url) {
    return targets.find((t) => t.url && t.url.includes(predicate.url));
  }
  if (predicate.title) {
    return targets.find((t) => t.title && t.title.includes(predicate.title));
  }
  if (predicate.id) {
    return targets.find((t) => t.id === predicate.id);
  }
  return targets[0];
}

async function probe(options) {
  return freshSocketProbe(options);
}

module.exports = {
  listTargets,
  pingClient,
  freshSocketProbe,
  probe,
  findTarget,
  DEFAULT_TIMEOUT_MS,
};
