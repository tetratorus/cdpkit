const http = require("http");
const CDP = require("chrome-remote-interface");

async function listTargets(host = "127.0.0.1", port = 9222) {
  const url = `http://${host}:${port}/json/list`;
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    const req = http.get(url, { timeout: 3000, agent }, (res) => {
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

function defaultPageTarget(targets) {
  return targets.find((t) => t.type === "page");
}

async function connect({ host = "127.0.0.1", port = 9222, target } = {}) {
  const targets = await listTargets(host, port);
  const chosen = target ? findTarget(targets, target) : defaultPageTarget(targets);
  if (!chosen) {
    throw new Error(`No CDP target matched ${JSON.stringify(target)} on ${host}:${port}`);
  }
  const client = await CDP({ host, port, target: chosen });
  return { client, target: chosen };
}

async function call(client, domain, method, params = {}) {
  if (!client[domain] || !client[domain][method]) {
    throw new Error(`Unknown CDP method ${domain}.${method}`);
  }
  return client[domain][method](params);
}

async function enable(client, domain) {
  if (!client[domain] || !client[domain].enable) {
    throw new Error(`Cannot enable unknown domain ${domain}`);
  }
  return client[domain].enable();
}

async function close(client) {
  if (!client) return;
  try {
    if (client._ws) {
      client._ws.terminate();
      if (client._ws._socket) {
        client._ws._socket.destroy();
      }
    } else {
      await client.close();
    }
    http.globalAgent.destroy();
  } catch {
    // ignore close errors
  }
}

module.exports = {
  listTargets,
  findTarget,
  connect,
  call,
  enable,
  close,
};
