# Granola CDP integration

Granola is an Electron app that gates `--remote-debugging-port` behind a `--granola-cdp-token=<token>` flag. The token is validated by a hardcoded SHA-256 hash inside `dist-electron/main/index.js`. The cleartext token is not present on disk, and the companion CLI requires enabling a Labs feature.

This branch contains a CDP-based driver plus instructions for patching a copy of the Granola app so it accepts any token during the first 60 seconds of startup.

## Files in this branch

- `apps.js` — launcher config for the patched app (`/Applications/Granola-cdp.app`)
- `drivers/granola.js` — CDP driver (start, stop, getContext)
- `index.js` — exports the `granola` driver
- `server.js` — optional local REST wrapper around Granola's companion CLI (Labs feature)
- `GRANOLA.md` — this file

## Patching Granola for CDP

1. Copy the original app:
   ```bash
   cp -R "/Applications/Granola.app" "/Applications/Granola-cdp.app"
   ```

2. Extract `app.asar`:
   ```bash
   npx asar extract /Applications/Granola-cdp.app/Contents/Resources/app.asar /tmp/granola-patch
   ```

3. Find the hardcoded SHA-256 hash `dLe` inside `dist-electron/main/index.js`. In the minified bundle it looks like:
   ```js
   let dLe = "76a3b3dd...";
   ```

4. Prepend a monkey-patch to the top of `dist-electron/main/index.js` that spoofs `sha256` for the first 60 seconds:
   ```js
   const __granola_crypto = require("node:crypto");
   const __granola_orig = __granola_crypto.createHash;
   const __granola_start = Date.now();
   const __granola_dle = "<paste the dLe hex hash here>";
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
   The 60-second timeout is relative to the patched module loading, not a hardcoded Unix timestamp. After that window, SHA-256 returns to normal so the rest of the app does not break.

5. Repack `app.asar` with native `.node` modules kept unpacked:
   ```bash
   rm -rf /Applications/Granola-cdp.app/Contents/Resources/app.asar.unpacked
   npx asar pack /tmp/granola-patch /Applications/Granola-cdp.app/Contents/Resources/app.asar --unpack '*.node'
   ```

6. Update `ElectronAsarIntegrity` in `Info.plist`. Electron checks this hash at launch, so a modified asar must have a matching hash:
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

7. Ad-hoc re-sign the patched bundle:
   ```bash
   codesign --force --deep --sign - /Applications/Granola-cdp.app
   ```

8. Launch with CDP enabled:
   ```bash
   /Applications/Granola-cdp.app/Contents/MacOS/Granola --granola-cdp-token=x --remote-debugging-port=9231
   ```

9. Verify CDP:
   ```bash
   curl http://127.0.0.1:9231/json/list
   ```

## Using cdpkit

```js
const { start, getContext } = require("./drivers/granola");

(async () => {
  const session = await start();
  console.log(session.target.url);   // app://ui/#/login
  const ctx = await getContext(session.client);
  console.log(ctx.currentPage);
})();
```

## Zsh aliases

```zsh
granolastart() {
  ( cd "$CDPKIT_DIR" && node -e "require('./drivers/granola').start().then(s => console.log('granola cdp on port', s.port))" )
}
granolastop() {
  _cdpkit_stop 9231 "Granola"
}
```

## Companion CLI alternative

If you enable the Labs Companion CLI in Granola, `server.js` exposes its commands over HTTP:

```bash
npm run server
```

Then query from the Granola console or another process:

```js
fetch("http://127.0.0.1:8787/recent?limit=5").then(r => r.json()).then(console.log);
```

## Caveats

- The patched app is ad-hoc signed; macOS may show a Gatekeeper warning the first time you run it.
- Because the signature changed, the patched app cannot read the original keychain entry for the device encryption key. You may need to log in again.
- The 60-second bypass window is enough for the CDP token check at startup but limits the risk of breaking later SHA-256 usage.
