const { spawn, execFile } = require("child_process");
const transport = require("./transport");
const state = require("./state");
const { apps } = require("./apps");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function reachable(host, port) {
  try {
    const targets = await transport.listTargets(host, port);
    return Array.isArray(targets) && targets.length > 0;
  } catch {
    return false;
  }
}

async function waitForCdp(host, port, attempts = 40, interval = 1000) {
  for (let i = 0; i < attempts; i++) {
    if (await reachable(host, port)) return;
    await sleep(interval);
  }
  throw new Error(`CDP did not become reachable on ${host}:${port}`);
}

function isAppRunning(app) {
  if (!app.processName) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("pgrep", ["-x", app.processName], (err) => {
      resolve(!err);
    });
  });
}

async function waitUntilDead(app, timeoutMs = 10000) {
  const start = Date.now();
  while (await isAppRunning(app)) {
    if (Date.now() - start > timeoutMs) break;
    await sleep(200);
  }
}

function killApp(app, wait = false) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", app.killCmd], { stdio: "ignore" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  }).then(async () => {
    if (wait) await waitUntilDead(app);
  });
}

function launchApp(app, port) {
  const args = app.launchArgs(port);
  const child = spawn(args[0], args.slice(1), {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function attach({ host = "127.0.0.1", port, target } = {}) {
  const { client, target: chosen } = await transport.connect({ host, port, target });
  if (chosen) {
    state.setLastWorking(host, port, { targetId: chosen.id });
  }
  return { client, target: chosen, host, port, ownsProcess: false };
}

async function start(appName, { host = "127.0.0.1", port, forceRelaunch = false, target } = {}) {
  if (!apps[appName]) throw new Error(`Unknown app: ${appName}`);
  const app = apps[appName];
  const targetPort = port || app.defaultPort;

  const alreadyCdp = await reachable(host, targetPort);
  if (alreadyCdp && !forceRelaunch) {
    const { client, target: chosen } = await transport.connect({ host, port: targetPort, target });
    if (chosen) {
      state.setLastWorking(host, targetPort, { targetId: chosen.id });
    }
    return { client, target: chosen, host, port: targetPort, ownsProcess: false, appName };
  }

  if (process.platform !== "darwin") {
    throw new Error(`Launching ${app.name} is only supported on macOS`);
  }

  if (alreadyCdp || (await isAppRunning(app)) || forceRelaunch) {
    await killApp(app, true);
    await sleep(1000);
  }

  await launchApp(app, targetPort);
  await waitForCdp(host, targetPort);

  async function restart() {
    if (!state.canRestart(host, targetPort)) {
      throw new Error(
        `CDP on ${host}:${targetPort} is unreachable; restart throttled (last restart too recent)`
      );
    }
    await killApp(app, true);
    await sleep(1000);
    await launchApp(app, targetPort);
    await waitForCdp(host, targetPort);
    state.setLastRestart(host, targetPort);
  }

  const { client, target: chosen } = await transport.connect({
    host,
    port: targetPort,
    target,
    restart,
  });
  state.setLastWorking(host, targetPort, { targetId: chosen.id });
  return { client, target: chosen, host, port: targetPort, ownsProcess: true, appName };
}

async function emergencyStop(session) {
  if (session && session.client) {
    await transport.close(session.client);
  }
  if (session && session.ownsProcess && session.appName) {
    const app = apps[session.appName];
    await killApp(app, false);
  }
}

module.exports = {
  attach,
  start,
  emergencyStop,
  reachable,
};
