---
name: cdpkit
description: Drive Chrome/Slack/Notion/Granola on the user's desktop via the cdpkit package
argument-hint: "<app> <task>"
allowed-tools:
  - exec
  - read
triggers:
  - user
  - model
---

# cdpkit skill

Use the cdpkit Node package as the working directory for all package commands. If cdpkit is the project root, that is `.`; otherwise it is the `cdpkit/` subpackage.

Install dependencies first:

```bash
npm install
```

## Drivers

Supported apps: `chrome`, `slack`, `notion`, `granola`.

```js
const app = "granola"; // or "slack", "notion", "chrome"
const driver = require(`./drivers/${app}`);

const s = await driver.start({ kill: false });
const ctx = await driver.getContext(s.client);
console.log(JSON.stringify(ctx, null, 2));
// ... use driver helpers ...
// Leave the app running unless you intentionally launched it and want to close it.
```

To see what a driver exposes at runtime:

```bash
node -e "console.log(Object.keys(require('./drivers/granola')))"
```

## Lifecycle

- Use `driver.start({ kill: false })` to attach to an already-open app.
- Do not call `driver.emergencyStop()` as a routine cleanup step. There is no need to ever stop the driver; leave apps open.
- Only use `driver.emergencyStop(s)` if you intentionally launched the app and want to quit it.

## Shell launcher aliases

cdpkit ships `scripts/aliases.sh`, a bash/zsh-compatible source file that defines launcher functions for the **user**. Add it to your shell rc:

```bash
# ~/.bashrc or ~/.zshrc
source /path/to/cdpkit/scripts/aliases.sh
```

Functions available:

- `chromestart [url]` — Chrome with CDP on port 9229
- `slackstart` — Slack with CDP on port 9228
- `notionstart` — Notion with CDP on port 9230
- `granolastart` — patched Granola with CDP on port 9231
- `chromestop`, `slackstop`, `notionstop`, `granolastop` — only use these when you intentionally want to quit the app

**Agents must not call these shell functions directly.** They are user-facing helpers. If an app is not already open with CDP reachable, ask the user to run the appropriate `*start` command, then use `driver.start({ kill: false })` to attach.

`scripts/aliases.sh` resolves `CDPKIT_DIR` from its own location, so it works regardless of where the repo is cloned. The implementations call the cdpkit drivers directly (`granola.start({ launch: true })` for Granola).

## Granola setup

Granola must be opened and logged in before cdpkit can attach. A fresh Granola launch always prompts for login/OAuth, which cdpkit cannot complete on its own, so any automation that tries to launch Granola from cold cannot get useful work done. Run `granolastart` (or open Granola manually), log in, then use `granola.start({ kill: false })` to attach.

## Granola search

Granola uses a local SQLite cache (`granola-documents.db`) that mirrors document metadata. Searches run against this local DB; transcripts are fetched separately only when needed.

```bash
# Search the local DB (auto-syncs if the cache is older than 10 minutes)
node -e "const g=require('./drivers/granola');(async()=>{const s=await g.start({kill:false});const r=await g.searchLocal(s.client,'Yan Shubhra');console.log(JSON.stringify(r,null,2));})();"

# Fetch the transcript for a specific document id
node -e "const g=require('./drivers/granola');(async()=>{const s=await g.start({kill:false});const t=await g.getTranscript(s.client,'MEETING-ID');console.log(JSON.stringify(t,null,2));})();"
```

- `granola.syncDocuments(client)` fetches all document IDs, expands them in 50-document batches, and upserts metadata/titles/notes into the local SQLite DB.
- `granola.searchLocal(client, query, { folder, limit })` syncs automatically if the cache is more than 1 hour old, then searches the local DB and returns `{ results, total, syncedAt, folder }`.
- `granola.getNote`, `getRecentCalls`, and `getTranscript` also ensure the cache is synced before making their API calls.
- `granola.getTranscript(client, id)` returns `{ meetingId, transcript, segments }`.

## Terminology

- **Document ID** — a UUID. The cache stores these plus metadata.
- **Document / meeting** — the object returned by `get-documents-batch`: `id`, `title`, `created_at`, `notes_plain`, `notes_markdown`, `people`, `overview`, etc. Not the transcript.
- **Transcript** — the spoken text from `get-document-transcript`, fetched separately with `granola.getTranscript`.

## Where to learn the API

- Implementation: `drivers/<app>.js` (slack.js, notion.js, chrome.js, granola.js)
- Lifecycle: `session.js` and `apps.js`
- Granola local DB: `db.js`, `drivers/granola.js`
- Low-level primitives: `primitives.js`, `transport.js`
- Overview: `README.md`

## Rules

- Read-only by default. `apiCall` rejects writes unless `{ allowWrite: true }` is passed.
- Do not post, send, edit, or mutate state in any app unless explicitly asked.
- Do not capture Chrome screenshots. They are sensitive and can trigger guardrails. Read the page with `getText`/`getTitle`/`getContext()` instead. Only capture a screenshot if the user explicitly asks for a visual artifact, and then use the underlying CDP primitives directly, not the chrome driver.
- For Granola, always use `granola.searchLocal`. It syncs automatically. Do not call `granola.search` directly.
- If you need a transcript, first find the document with `searchLocal`, then call `granola.getTranscript` with that `id`.
- Do not stop or kill an app that the user already had open. There is no need to ever stop the driver; leave apps open. Only use `driver.emergencyStop(s)` when you intentionally launched the app and want to close it.
