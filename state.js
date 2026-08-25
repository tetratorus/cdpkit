const fs = require("fs");
const os = require("os");
const path = require("path");

const stateDir = path.join(os.homedir(), ".cdpkit");
const stateFile = path.join(stateDir, "state.json");

const STALE_MS = 5 * 60 * 1000;

function loadState() {
  try {
    if (!fs.existsSync(stateFile)) return {};
    const raw = fs.readFileSync(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch {
    // best effort
  }
}

function keyFor(host, port) {
  return `${host}:${port}`;
}

function getEndpoint(host, port) {
  const state = loadState();
  return (state.endpoints && state.endpoints[keyFor(host, port)]) || {};
}

function setEndpoint(host, port, data) {
  const state = loadState();
  if (!state.endpoints) state.endpoints = {};
  const k = keyFor(host, port);
  state.endpoints[k] = { ...(state.endpoints[k] || {}), ...data, host, port };
  saveState(state);
}

function getLastWorkingAt(host, port) {
  const ep = getEndpoint(host, port);
  return ep.lastWorkingAt || null;
}

function setLastWorking(host, port, extra = {}) {
  setEndpoint(host, port, {
    lastWorkingAt: Date.now(),
    ...extra,
  });
}

function setLastFailure(host, port, error) {
  setEndpoint(host, port, {
    lastFailureAt: Date.now(),
    lastError: error ? error.message || String(error) : null,
  });
}

function setLastRestart(host, port) {
  setEndpoint(host, port, {
    lastRestartAt: Date.now(),
  });
}

function getLastRestartAt(host, port) {
  const ep = getEndpoint(host, port);
  return ep.lastRestartAt || null;
}

function isStale(host, port, maxAgeMs = STALE_MS) {
  const last = getLastWorkingAt(host, port);
  if (!last) return true;
  return Date.now() - last > maxAgeMs;
}

function canRestart(host, port, maxAgeMs = STALE_MS) {
  const lastRestart = getLastRestartAt(host, port);
  if (!lastRestart) return true;
  const lastWorking = getLastWorkingAt(host, port);
  if (lastWorking && lastWorking > lastRestart) {
    // app had a healthy period after the last restart, so this is a new incident
    return true;
  }
  return Date.now() - lastRestart > maxAgeMs;
}

module.exports = {
  STALE_MS,
  loadState,
  saveState,
  getEndpoint,
  setEndpoint,
  getLastWorkingAt,
  setLastWorking,
  setLastFailure,
  setLastRestart,
  getLastRestartAt,
  isStale,
  canRestart,
};
