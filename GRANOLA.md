# Granola CDP Patching & Integration Guide

A standalone handover recipe for patching a local Granola install so it exposes a Chrome DevTools Protocol (CDP) endpoint that `cdpkit` can drive.

## What you are trying to do

Granola is an Electron app. Electron itself supports `--remote-debugging-port=<port>`, which would normally let you attach Chrome DevTools or any CDP client. Granola intentionally gates that capability: it only enables CDP when you also pass `--granola-cdp-token=<token>` and that token matches a value the app derives from the machine.

The goal is to bypass that gate on a copy of the app so that `cdpkit` can connect to the renderer process and drive Granola programmatically.

## Why the gate exists and how it works

Granola computes a per-machine "device ID" and then hashes it with SHA-256. Roughly:

```
let deviceId  = getDeviceId()          // e.g. IOPlatformUUID on macOS
let cdpToken  = sha256(deviceId)       // the expected token
let userToken = sha256(process.argv['--granola-cdp-token'])
if (userToken === cdpToken) enableRemoteDebugging()
```

The exact variable names and the `getDeviceId()` implementation change between builds, but the pattern is consistent: **SHA-256 of something machine-specific**.

Rather than reverse-engineering the device-ID derivation for every update, we patch `node:crypto.createHash` so that for the first ~60 seconds of process life, any `sha256(...)` returns the same fake digest. That means:

- `cdpToken` becomes the fake digest.
- `userToken` becomes the fake digest.
- The comparison succeeds for any `--granola-cdp-token` value.

After 60 seconds the monkey-patch removes itself so the rest of the app (Sentry, AWS signing, etc.) uses real SHA-256 again.

This is the fish. The next sections explain how to fish — i.e. how to reproduce this on a fresh Granola version or a fresh Mac.

## Prerequisites (do this first on a fresh machine)

1. Download and install Granola normally.
2. Launch it, log in, and let it sync.
3. Grant all the macOS permissions it asks for (microphone, accessibility, screen recording, calendar, etc.).
4. Run it long enough that Gatekeeper has marked it as approved.

This matters because:

- Granola stores your encrypted meeting cache and credentials in `~/Library/Application Support/Granola`.
- A freshly downloaded copy gets the `com.apple.quarantine` extended attribute and Gatekeeper will block it.
- An already-approved local copy does not get re-quarantined when you duplicate it.

## The high-level strategy

1. **Copy** the approved app to `Granola-cdp.app`.
2. **Extract** `Contents/Resources/app.asar`.
3. **Inject** a `node:crypto.createHash` shim into the main Electron bundle.
4. **Repack** `app.asar`.
5. **Update** `ElectronAsarIntegrity` in `Info.plist` so Electron accepts the modified asar.
6. **Ad-hoc sign** the bundle so macOS will run it.
7. **Launch** with `--granola-cdp-token=x --remote-debugging-port=9231`.
8. **Point `cdpkit`** at the patched app.

## Patching steps

### 1. Copy the installed app

```bash
cp -R "/Applications/Granola.app" "/Applications/Granola-cdp.app"
```

This is the copy you will modify. Keep `Granola.app` untouched.

### 2. Extract app.asar

```bash
npx asar extract /Applications/Granola-cdp.app/Contents/Resources/app.asar /tmp/granola-patch
```

### 3. Inject the crypto shim

Open `/tmp/granola-patch/dist-electron/main/index.js` in an editor. It is one giant minified line.

Prepend this to the very top of the file:

```js
const __granola_crypto = require("node:crypto");
const __granola_orig = __granola_crypto.createHash;
const __granola_start = Date.now();
const __granola_dle = "0000000000000000000000000000000000000000000000000000000000000000";
const __granola_dle_buf = Buffer.from(__granola_dle, "hex");
__granola_crypto.createHash = function(algorithm, options) {
  if (algorithm !== "sha256" || Date.now() - __granola_start > 60000) {
    return __granola_orig.call(__granola_crypto, algorithm, options);
  }
  return {
    update(data, enc) { return this; },
    digest(enc) {
      if (enc === "hex") return __granola_dle;
      if (enc) return __granola_dle_buf.toString(enc);
      return __granola_dle_buf;
    },
  };
};
```

You can replace the zero hash with any 64-character hex string. The exact value does not matter. During the 60-second window Granola will compute its own `cdpToken` through this same shim, so both sides of the comparison will be the same fake digest.

**Why prepend?** `dist-electron/main/index.js` is the main process entry. Loading it is the first thing Electron does. By putting the shim at the very top, every later `require("node:crypto")` and every `createHash` call in the main process sees the patched version.

**Why only `sha256` and only 60 seconds?** The app legitimately uses SHA-256 for telemetry, AWS request signing, and `ElectronAsarIntegrity`. If we left the shim on forever, Granola would break. The 60-second window is long enough for the CDP token check at startup and short enough to leave everything else alone.

### 4. Repack app.asar

```bash
rm -rf /Applications/Granola-cdp.app/Contents/Resources/app.asar.unpacked
npx asar pack /tmp/granola-patch /Applications/Granola-cdp.app/Contents/Resources/app.asar --unpack '*.node'
```

Keep `.node` native modules unpacked so macOS code-signing and dyld loading work.

### 5. Update ElectronAsarIntegrity in Info.plist

Electron stores a hash of the asar header in `Info.plist` and validates it at startup. A modified asar will fail this check unless you update the hash.

```js
const asar = require("@electron/asar");
const crypto = require("crypto");
const fs = require("fs");

const appAsar = "/Applications/Granola-cdp.app/Contents/Resources/app.asar";
const plistPath = "/Applications/Granola-cdp.app/Contents/Info.plist";

const rawHeader = asar.getRawHeader(appAsar);
const hash = crypto.createHash("sha256").update(rawHeader.headerString).digest("hex");

let plist = fs.readFileSync(plistPath, "utf8");
const regex = /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app.asar<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>SHA256<\/string>\s*<key>hash<\/key>\s*<string>)[a-f0-9]{64}(<\/string>\s*<\/dict>\s*<\/dict>)/;
plist = plist.replace(regex, "$1" + hash + "$2");
fs.writeFileSync(plistPath, plist);
```

### 6. Ad-hoc sign the patched app

```bash
codesign --force --deep --sign - /Applications/Granola-cdp.app
```

The original signature is now invalid because you changed `app.asar`. Ad-hoc signing (`-`) is fine for local use.

### 7. Launch and verify CDP

```bash
/Applications/Granola-cdp.app/Contents/MacOS/Granola --granola-cdp-token=x --remote-debugging-port=9231
```

Then in another terminal:

```bash
curl http://127.0.0.1:9231/json/list
```

You should get a JSON list of targets.

### 8. Wire up `cdpkit`

`cdpkit/apps.js` already points at the patched app and passes the right flags. `drivers/granola.js` starts Granola and connects to the first `app://ui` target.

```js
const { start, getContext } = require("./drivers/granola");

(async () => {
  const session = await start();
  console.log(session.target.url);
  const ctx = await getContext(session.client);
  console.log(ctx.currentPage);
})();
```

## How to fish: adapting this to a new Granola version

The code is minified, so the variable names (`dLe`, `iNe`, `qF`, etc.) will be different next release. Look for these patterns instead of names:

1. Search the extracted `dist-electron/main/*.js` files for `createHash` and `sha256`.
2. Look for code that reads `process.argv` for a token-like switch (e.g. `--granola-cdp-token`, `--cdp-token`, or similar).
3. Trace where that token is hashed and compared to a value that is itself derived from `IOPlatformUUID`/`getDeviceId`/`machine-id`.
4. The simplest fix is still the same: make every `sha256` in the first 60 seconds return a constant. That covers the computed `cdpToken` and the user-provided token, so they match.

If the app starts refusing `--granola-cdp-token` entirely, the next step is to find the `app.commandLine.appendSwitch("remote-debugging-port", ...)` call and force it on, then remove the `if (tokenIsValid)` guard.

## Gatekeeper notes

- `com.apple.quarantine` is the attribute that triggers "cannot be opened because the developer cannot be verified."
- A duplicated, already-approved app generally does not get a new quarantine flag.
- If you do hit Gatekeeper, remove the flag from your patched copy only:
  ```bash
  xattr -dr com.apple.quarantine /Applications/Granola-cdp.app
  ```
- The ad-hoc signature is enough for a local, non-quarantined bundle, but it will not satisfy Gatekeeper for a fresh download.

## Caveats

- The patched app cannot read the original keychain entry for the device encryption key because the signature changed. You may need to log in again.
- Granola auto-updates. After an update, the live `Granola.app` will be newer than `Granola-cdp.app`. Re-run the patch from the updated `Granola.app`.
- The 60-second crypto shim is intentionally narrow. If Granola starts doing important SHA-256 work in the first 60 seconds on a future build, the shim may need to become more targeted (e.g. only spoof calls that include the token or device-id).
- This is for local automation only. Do not distribute the patched bundle.
