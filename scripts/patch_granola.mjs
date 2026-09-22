#!/usr/bin/env node
// Patch the installed Granola app into a CDP-enabled copy at ~/Applications/Granola-cdp.app.
// Strategy: Granola only enables remote debugging when --granola-cdp-token hashes to a
// hardcoded digest inside the app. We monkey-patch node:crypto.createHash("sha256") so
// every digest in the first 60s returns that digest, making the check succeed for any token.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as asar from "@electron/asar";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const home = os.homedir();

const sourceApp = "/Applications/Granola.app";
const targetApp = path.join(home, "Applications", "Granola-cdp.app");
const targetAsar = path.join(targetApp, "Contents", "Resources", "app.asar");
const targetPlist = path.join(targetApp, "Contents", "Info.plist");
const mainJsPathInsideAsar = "dist-electron/main/index.js";

function run(cmd, args = []) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit" });
}

async function backupAndCopyTarget() {
  if (existsSync(targetApp)) {
    const backup = `${targetApp}.bak`;
    if (existsSync(backup)) {
      await rm(backup, { recursive: true, force: true });
    }
    console.log(`Backing up existing ${targetApp} -> ${backup}`);
    run("cp", ["-R", targetApp, backup]);
    await rm(targetApp, { recursive: true, force: true });
  }
  console.log(`Copying ${sourceApp} -> ${targetApp}`);
  run("cp", ["-R", sourceApp, targetApp]);
  // Ensure we can write into the copied bundle.
  run("chmod", ["-R", "u+w", targetApp]);
}

async function extractToTemp(tmpDir) {
  const extractDir = path.join(tmpDir, "extract");
  console.log("Extracting app.asar...");
  await asar.extractAll(targetAsar, extractDir);
  return extractDir;
}

function findCdpHash(mainSource) {
  // Look for the granola-cdp-token string literal, then the following 64-char hex digest.
  const match = mainSource.match(
    /granola-cdp-token[`'"]\s*,\s*[^=]+=\s*[`'"]([a-f0-9]{64})[`'"]/i
  );
  if (!match) {
    throw new Error("Could not find hardcoded CDP token hash in Granola bundle");
  }
  const hash = match[1];
  console.log("Found hardcoded CDP token hash:", hash);
  return hash;
}

function buildShim(hash) {
  return `
(() => {
  const __granola_hash = ${JSON.stringify(hash)};
  const __granola_buf = Buffer.from(__granola_hash, "hex");
  const __granola_start = Date.now();
  const __granola_patch = (mod) => {
    if (!mod || !mod.createHash || mod.__granola_patched) return;
    mod.__granola_patched = true;
    const orig = mod.createHash;
    mod.createHash = function(algorithm, options) {
      if (algorithm !== "sha256" || Date.now() - __granola_start > 60000) {
        return orig.call(mod, algorithm, options);
      }
      return {
        update(data, encoding) { return this; },
        digest(encoding) {
          if (encoding === "hex") return __granola_hash;
          if (encoding === "base64") return __granola_buf.toString("base64");
          if (encoding === "buffer" || encoding === undefined) return __granola_buf;
          return __granola_buf.toString(encoding);
        }
      };
    };
  };
  __granola_patch(require("crypto"));
  __granola_patch(require("node:crypto"));
})();
`;
}

async function patchMainJs(extractDir, hash) {
  const mainPath = path.join(extractDir, mainJsPathInsideAsar);
  const source = await readFile(mainPath, "utf8");
  const shim = buildShim(hash);
  console.log("Injecting SHA-256 shim into", mainPath);
  await writeFile(mainPath, shim + source);
}

async function repack(extractDir) {
  const unpackedDir = `${targetAsar}.unpacked`;
  if (existsSync(unpackedDir)) {
    await rm(unpackedDir, { recursive: true, force: true });
  }
  console.log("Repacking app.asar...");
  await asar.createPackageWithOptions(extractDir, targetAsar, {
    unpack: "*.node",
  });
}

async function updatePlist() {
  const raw = asar.getRawHeader(targetAsar);
  const hash = createHash("sha256").update(raw.headerString).digest("hex");
  console.log("New asar header hash:", hash);
  let plist = await readFile(targetPlist, "utf8");
  const regex = /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>SHA256<\/string>\s*<key>hash<\/key>\s*<string>)[a-f0-9]{64}(<\/string>\s*<\/dict>\s*<\/dict>)/;
  if (!regex.test(plist)) {
    throw new Error("Could not find ElectronAsarIntegrity block in Info.plist");
  }
  plist = plist.replace(regex, `$1${hash}$2`);
  await writeFile(targetPlist, plist);
}

async function signAndQuarantine() {
  console.log("Ad-hoc signing bundle...");
  run("codesign", ["--force", "--deep", "--sign", "-", targetApp]);
  console.log("Removing quarantine attribute...");
  run("xattr", ["-dr", "com.apple.quarantine", targetApp]);
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Granola patching is only supported on macOS");
  }
  if (!existsSync(sourceApp)) {
    throw new Error(`Source app not found: ${sourceApp}`);
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "granola-patch-"));
  try {
    await backupAndCopyTarget();
    const extractDir = await extractToTemp(tmpDir);
    const mainSource = await readFile(path.join(extractDir, mainJsPathInsideAsar), "utf8");
    const hash = findCdpHash(mainSource);
    await patchMainJs(extractDir, hash);
    await repack(extractDir);
    await updatePlist();
    await signAndQuarantine();
    console.log(`\nGranola patched successfully at ${targetApp}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
