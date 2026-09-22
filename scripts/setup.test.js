const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cdpkit-setup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, "../db.js"), path.join(root, "db.js"));
  const env = { ...process.env };
  delete env.GRANOLA_DB_PATH;
  return { root, env };
}

test("a fresh setup creates its cache under data, not the package root", (t) => {
  const { root, env } = fixture(t);
  const result = spawnSync(process.execPath, ["-e", "require('./db')"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(root, "data/granola-documents.db")));
  assert.equal(fs.existsSync(path.join(root, "granola-documents.db")), false);
});

test("a custom cache location is created without needing pre-existing directories", (t) => {
  const { root, env } = fixture(t);
  env.GRANOLA_DB_PATH = path.join(root, "custom/nested/cache.db");
  const result = spawnSync(process.execPath, ["-e", "require('./db')"], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(env.GRANOLA_DB_PATH));
  assert.equal(fs.existsSync(path.join(root, "data")), false);
});

for (const shell of ["bash", "zsh"]) {
  test(`${shell} launchers install once and work from a clone path containing spaces`, (t) => {
    const { root, env } = fixture(t);
    delete env.CDPKIT_DIR;
    delete env.BASH_ENV;
    const clone = path.join(root, "clone with spaces");
    const scripts = path.join(clone, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    for (const file of ["aliases.sh", "install-aliases.sh"]) {
      fs.copyFileSync(path.join(__dirname, file), path.join(scripts, file));
    }
    const rc = path.join(root, "shellrc");
    for (let attempt = 0; attempt < 2; attempt++) {
      const install = spawnSync("bash", [path.join(scripts, "install-aliases.sh"), rc], { env, encoding: "utf8" });
      assert.equal(install.status, 0, install.stderr);
    }
    assert.equal(fs.readFileSync(rc, "utf8").split("# >>>> cdpkit app launchers >>>>").length, 2);
    const loaded = spawnSync(shell, ["-f", "-c", 'source "$1"; test "$CDPKIT_DIR" = "$2" && command -v notionstart && command -v teamsstart', "cdpkit-test", rc, clone], {
      env, encoding: "utf8",
    });
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.equal(loaded.stdout.trim(), "notionstart\nteamsstart");
  });
}

test("the package entry exports every driver without launching an app", () => {
  const result = spawnSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const kit = require(".");
    for (const name of ["chrome", "slack", "notion", "granola", "teams"]) {
      assert.equal(typeof kit[name], "function", name);
      assert.equal(typeof kit[name].getContext, "function", name);
    }
  `], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, GRANOLA_DB_PATH: ":memory:" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
