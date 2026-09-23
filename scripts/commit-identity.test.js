const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const PKG = path.join(__dirname, "..");
const MAINTAINER = ["-c", "user.name=CDPKit Maintainer", "-c", "user.email=maintainer@example.invalid"];
const PERSONAL = ["-c", "user.name=Someone Else", "-c", "user.email=someone@example.com"];

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdpkit-identity-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
  for (const k of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(k)) delete env[k];
  const run = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  const git = (cwd, ...args) => run(cwd, "git", args);
  const repo = path.join(dir, "repo");
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  git(repo, "remote", "add", "origin", remote);
  const install = run(PKG, "sh", ["scripts/install-hooks.sh", repo]);
  assert.equal(install.status, 0, install.stderr);
  const commit = (identity, file, ...extra) => {
    fs.writeFileSync(path.join(repo, file), file);
    git(repo, "add", file);
    return git(repo, ...identity, "commit", "-q", "-m", file, ...extra);
  };
  return { repo, git, commit };
}

test("pre-commit rejects a personal identity and accepts the maintainer", (t) => {
  const { commit } = sandbox(t);
  const bad = commit(PERSONAL, "a");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /author would be Someone Else <someone@example.com>/);
  assert.equal(commit(MAINTAINER, "a").status, 0);
});

test("pre-push rejects commits that bypassed the pre-commit hook", (t) => {
  const { repo, git, commit } = sandbox(t);
  assert.equal(commit(MAINTAINER, "a").status, 0);
  assert.equal(git(repo, "push", "-q", "origin", "main").status, 0);
  assert.equal(commit(PERSONAL, "b", "--no-verify").status, 0);
  const push = git(repo, "push", "-q", "origin", "main");
  assert.notEqual(push.status, 0);
  assert.match(push.stderr, /Someone Else <someone@example.com>/);
});

test("installer refuses to overwrite hooks it does not manage", (t) => {
  const { repo, git } = sandbox(t);
  const hooks = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "hooks").stdout.trim();
  fs.writeFileSync(path.join(hooks, "pre-push"), "#!/bin/sh\necho custom\n");
  const r = spawnSync("sh", ["scripts/install-hooks.sh", repo], { cwd: PKG, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not managed by cdpkit/);
});
