const http = require("http");
const CDP = require("chrome-remote-interface");
const probe = require("./probe");
const state = require("./state");

const IS_PROBED = Symbol.for("cdpkit.probedClient");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listTargets(host = "127.0.0.1", port = 9222) {
  return probe.listTargets(host, port);
}

function findTarget(targets, predicate) {
  return probe.findTarget(targets, predicate);
}

function defaultPageTarget(targets) {
  return targets.find((t) => t.type === "page");
}

function createProbedClient({ host, port, predicate, realClient, restart }) {
  const handlers = new Map();
  let currentClient = realClient;

  async function closeReal() {
    try {
      if (currentClient && currentClient._ws) {
        currentClient._ws.terminate();
        if (currentClient._ws._socket) {
          currentClient._ws._socket.destroy();
        }
      } else if (currentClient) {
        await currentClient.close();
      }
    } catch {
      // ignore
    }
    currentClient = null;
  }

  async function attachHandlers(client) {
    if (!client || typeof client.on !== "function") return;
    for (const [event, handlersSet] of handlers) {
      for (const handler of handlersSet) {
        client.on(event, handler);
      }
    }
  }

  async function reconnect() {
    await closeReal();
    const targets = await listTargets(host, port);
    const chosen = predicate ? findTarget(targets, predicate) : defaultPageTarget(targets);
    if (!chosen) {
      throw new Error(`No CDP target matched ${JSON.stringify(predicate)} on ${host}:${port}`);
    }
    currentClient = await CDP({ host, port, target: chosen });
    await attachHandlers(currentClient);
  }

  async function restartAndReconnect() {
    if (typeof restart !== "function") {
      throw new Error(`CDP on ${host}:${port} is unreachable and no restart callback is configured`);
    }
    await restart();
    await reconnect();
  }

  async function callWithProbe(domain, method, params) {
    const epKey = `${host}:${port}`;
    try {
      const ping = await probe.pingClient(currentClient, 3000);
      if (!ping.ok) throw new Error("ping returned unexpected value");
    } catch (err) {
      // first ping failed; try a reconnect
      try {
        await reconnect();
        const ping = await probe.pingClient(currentClient, 3000);
        if (!ping.ok) throw new Error("ping returned unexpected value");
      } catch {
        // reconnect failed; try restart if available
        await restartAndReconnect();
        const ping = await probe.pingClient(currentClient, 3000);
        if (!ping.ok) throw new Error("ping returned unexpected value");
      }
    }

    if (!currentClient[domain] || !currentClient[domain][method]) {
      throw new Error(`Unknown CDP method ${domain}.${method}`);
    }

    try {
      const result = await currentClient[domain][method](params);
      state.setLastWorking(host, port, { targetId: currentClient._target && currentClient._target.id });
      return result;
    } catch (err) {
      state.setLastFailure(host, port, err);
      throw err;
    }
  }

  const proxy = new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === IS_PROBED || prop === "__isProbedClient") return true;
        if (prop === "_ws") return currentClient && currentClient._ws;
        if (prop === "_target") return currentClient && currentClient._target;
        if (prop === "then") return undefined;
        if (prop === "close") {
          return () => closeReal();
        }
        if (prop === "on") {
          return (event, handler) => {
            if (!handlers.has(event)) handlers.set(event, new Set());
            handlers.get(event).add(handler);
            if (currentClient && typeof currentClient.on === "function") {
              currentClient.on(event, handler);
            }
          };
        }
        if (prop === "off") {
          return (event, handler) => {
            if (handlers.has(event)) handlers.get(event).delete(handler);
            if (currentClient && typeof currentClient.off === "function") {
              currentClient.off(event, handler);
            }
          };
        }

        // Domain methods
        if (currentClient && currentClient[prop]) {
          return new Proxy(
            {},
            {
              get(_, method) {
                if (method === "then") return undefined;
                return async function (params) {
                  return callWithProbe(prop, method, params);
                };
              },
            }
          );
        }

        return currentClient && currentClient[prop];
      },
    }
  );

  return proxy;
}

async function connect({ host = "127.0.0.1", port = 9222, target, restart } = {}) {
  const targets = await listTargets(host, port);
  const chosen = target ? findTarget(targets, target) : defaultPageTarget(targets);
  if (!chosen) {
    throw new Error(`No CDP target matched ${JSON.stringify(target)} on ${host}:${port}`);
  }
  const realClient = await CDP({ host, port, target: chosen });
  const client = createProbedClient({ host, port, predicate: target, realClient, restart });
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
    if (client.__isProbedClient) {
      await client.close();
      return;
    }
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
  IS_PROBED,
  listTargets,
  findTarget,
  connect,
  call,
  enable,
  close,
};
