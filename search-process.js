const { spawn } = require("child_process");
const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

function generateId() {
  return crypto.randomBytes(5).toString("hex");
}

function startSearchProcess(keyword, { folder } = {}) {
  if (!keyword) throw new Error("keyword is required");
  const id = generateId();
  const filePath = path.join(os.tmpdir(), `granola-search-${id}.json`);
  const args = ["search-worker.js", filePath, keyword];
  if (folder) args.push(folder);

  const child = spawn("node", args, {
    cwd: __dirname,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { pid: child.pid, filePath };
}

async function getSearchProcessStatus(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch (err) {
    if (err.code === "ENOENT") return { status: "starting" };
    throw err;
  }
}

function waitForFileChange(filePath, timeoutMs) {
  return new Promise((resolve) => {
    let watcher;
    let timer;
    function done(changed) {
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
      resolve(changed);
    }
    try {
      watcher = fsSync.watch(filePath, () => done(true));
    } catch (err) {
      return resolve(false);
    }
    timer = setTimeout(() => done(false), timeoutMs);
  });
}

async function longPollFile(filePath, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getSearchProcessStatus(filePath);
    if (state.results && state.results.length) return state;
    if (state.complete || state.status === "error" || state.status === "done") return state;
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    const changed = await waitForFileChange(filePath, remaining);
    if (changed) continue;
  }
  return getSearchProcessStatus(filePath);
}

function stopSearchProcess(pid) {
  try {
    process.kill(pid);
    return true;
  } catch (err) {
    return false;
  }
}

module.exports = {
  startSearchProcess,
  getSearchProcessStatus,
  longPollFile,
  stopSearchProcess,
};
