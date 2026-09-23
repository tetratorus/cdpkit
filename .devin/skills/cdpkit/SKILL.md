---
name: cdpkit
description: Drive Chrome/Slack/Notion/Granola/Teams on the user's desktop via the cdpkit package
argument-hint: "<app> <task>"
allowed-tools:
  - exec
  - read
triggers:
  - user
  - model
---

# cdpkit skill

**Working directory:** Use the cdpkit package root as the working directory for all cdpkit commands and `require('./drivers/<app>')` calls. Do not run commands from `.devin/skills/cdpkit/`.

**Scripts and data:** Keep reusable toolkit utilities in `scripts/`. Put all one-off scripts and non-core engineering work in `data/scripts/`. Put private material, transcripts, search results, caches, and generated artifacts in `data/`. The entire `data/` directory is gitignored; never stage its contents.

Use Node.js 22.13 or newer. Install locked dependencies first:

```bash
npm ci
```

## Drivers

Supported apps: `chrome`, `slack`, `notion`, `granola`, `teams`.

```js
const app = "granola"; // or "slack", "notion", "chrome"
const driver = require(`./drivers/${app}`);

const s = await driver();
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

`driver()` first checks whether the CDP port is reachable. If it is, it attaches and does not restart.

If CDP is not reachable:

- **Slack / Notion** — if the app is running, kill and relaunch it with `--remote-debugging-port`; if it is not running, start it.
- **Chrome** — if the app is not running, start it from cold; if it is already running without CDP, throw and ask the user to run `chromestart` (or quit Chrome first).
- **Granola** — always throw and ask the user to run `granolastart`. The agent never launches or kills Granola.
- **Teams** — always throw and ask the user to run `teamsstart`. The agent never launches, restarts, or quits Teams.

Do not call `driver.emergencyStop()` as a routine cleanup step. There is no need to ever stop the driver; leave apps open. Only use `driver.emergencyStop(s)` if you intentionally launched the app and want to quit it.

## Shell launcher aliases

cdpkit ships `scripts/aliases.sh`, a bash/zsh-compatible source file that defines launcher functions for the **user**. Install it into your shell rc with:

```bash
./scripts/install-aliases.sh
```

This detects the cdpkit path and appends a `source` line to `~/.zshrc` (or `~/.bashrc`). You can also pass an explicit rc file: `./scripts/install-aliases.sh ~/.zshrc`.

Functions available:

- `chromestart [url]` — Chrome with CDP on port 9229. Attaches if CDP is already up, starts from cold if Chrome is not running, and errors if Chrome is already running without CDP.
- `slackstart` — Slack with CDP on port 9228. Attaches if CDP is up, otherwise kills/restarts or starts Slack.
- `notionstart` — Notion with CDP on port 9230. Attaches if CDP is up, otherwise kills/restarts or starts Notion.
- `granolastart` — patched Granola with CDP on port 9231. Attaches if CDP is already up, starts from cold if Granola is not running, and errors if Granola is already running without CDP.
- `teamsstart` — Microsoft Teams with WebView2 CDP on port 9232. Attaches if CDP is already up, starts from cold if Teams is not running, and errors if Teams is already running without CDP.
- `chromestop`, `slackstop`, `notionstop`, `granolastop` — only use these when you intentionally want to quit the app

**Agents must not call these shell functions directly.** They are user-facing helpers. If an app is not already open with CDP reachable, ask the user to run the appropriate `*start` command, then use `driver()` to attach.

`scripts/aliases.sh` resolves `CDPKIT_DIR` from its own location, so it works regardless of where the repo is cloned. The implementations call the cdpkit drivers directly (`granola({ launch: true })` for Granola).

## Teams desktop

`teams()` attaches to the native macOS app on loopback port 9232. It never launches or restarts the app. The user-facing `teamsstart` launcher enables WebView2 CDP from a cold start and refuses to restart an already-running app without CDP.

`teams.getContext(client)` returns `{ app, title, url, currentView, text }` without screenshots. Default attachment selects a focused populated Teams page or the sole populated page. If several match, use `teams.listTargets()` and pass `teams({ target: { id: "TARGET_ID" } })`. Connections stay pinned to that target ID.

For chat content, use the data helpers, not `getText`. They send read-only GraphQL queries through Teams' own in-page client, and Teams' data worker does the authentication and network calls. Nothing is copied out of Teams except results.

- `teams.getConversations(client)`: recent chats with `id`, `title`, `type`, and last message.
- `teams.getMessages(client, conversationId, { limit, since, cursor })`: full history, newest first, paging back to the start of the chat. Returns `{ messages, nextCursor, hasMore }`, and each message has `time`, `from`, and plain `text`.
- `teams.getChannels(client)`, `teams.getReplyChains(client, channelId)`, `teams.getThreadReplies(client, channelId, replyChainId)`: channel threads.
- `teams.searchMessages(client, query, { page })`: server-side search across chats and channels, 25 results per page.
- `teams.getMembers(client, conversationId)`, `teams.getCurrentUser(client)`, `teams.getCurrentView(client)`.
- `teams.gqlQuery(client, query, variables)`: other read-only queries. Mutations and subscriptions are rejected.

```bash
node -e "const t=require('./drivers/teams');(async()=>{const s=await t();for(const c of await t.getConversations(s.client)){const r=await t.getMessages(s.client,c.id,{limit:20});console.log(c.title);for(const m of r.messages.reverse())console.log(' ',m.time,m.from+':',m.text)}process.exit(0)})();"
```

## Granola setup

Granola must be opened and logged in before cdpkit can attach. A fresh Granola launch always prompts for login/OAuth, which cdpkit cannot complete on its own. `granolastart` starts Granola from cold if it is not running, or attaches if CDP is already up; it errors if Granola is already running without CDP. After the user logs in, use `granola()` to attach.

## Granola search

Granola uses a local SQLite cache (`data/granola-documents.db`) that mirrors document metadata. Searches run against this local DB; transcripts are fetched separately only when needed.

```bash
# Search the local DB (auto-syncs if the cache is older than 10 minutes)
node -e "const g=require('./drivers/granola');(async()=>{const s=await g();const r=await g.searchLocal(s.client,'project planning');console.log(JSON.stringify(r,null,2));})();"

# Fetch the transcript for a specific document id
node -e "const g=require('./drivers/granola');(async()=>{const s=await g();const t=await g.getTranscript(s.client,'MEETING-ID');console.log(JSON.stringify(t,null,2));})();"
```

- `granola.syncDocuments(client)` fetches all document IDs, expands them in 50-document batches, and upserts metadata/titles/notes into the local SQLite DB.
- `granola.searchLocal(client, query, { folder, limit })` syncs automatically if the cache is more than 1 hour old, then searches the local DB and returns `{ results, total, syncedAt, folder }`.
- `granola.getNote`, `getRecentCalls`, and `getTranscript` also ensure the cache is synced before making their API calls.
- `granola.getTranscript(client, id)` returns `{ meetingId, transcript, segments }`.

## Terminology

- **Document ID** — a UUID. The cache stores these plus metadata.
- **Document / meeting** — the object returned by `get-documents-batch`: `id`, `title`, `created_at`, `notes_plain`, `notes_markdown`, `people`, `overview`, etc. Not the transcript.
- **Transcript** — the spoken text from `get-document-transcript`, fetched separately with `granola.getTranscript`.

## Slack file downloads

Use `scripts/download_slack_file.js` to download a file posted in a Slack channel:

```bash
node scripts/download_slack_file.js <channel> "<file-name-or-query>" [output-directory]
```

**Pitfall:** `files.slack.com` blocks the Slack renderer's `fetch()` when custom headers like `Authorization` are added. Keep credentials inside the renderer by passing `{ credentials: 'include' }` and returning the bytes through CDP. Never ship Slack tokens/cookies out to Node `https`.

## Where to learn the API

- Implementation: `drivers/<app>.js` (slack.js, notion.js, chrome.js, granola.js, teams.js)
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
