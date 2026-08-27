# cdpkit

A CDP toolkit for agents to observe and operate Chrome, Slack, and Notion on the user's desktop.

Import the driver for the app you need and call it from a Node script:

```js
const slack = require("./drivers/slack");
```

## Agent workflow

1. Start or attach to the app: `slack.start()` / `notion.start()` / `chrome.start()`.
2. Get context: `driver.getContext(client)` returns the current state. Slack, Notion, and Granola also include a screenshot; Chrome returns title, URL, and visible text only because of screenshot safeguards.
3. Inspect the returned state to identify the active channel, page, or selection.
4. Fetch data with read methods like `getMessages`, `searchMessages`, `getText`, `search`, or (for Granola) `search-process`.
5. Leave the app running. There is no need to call `driver.emergencyStop(s)` unless you intentionally launched the app and want to quit it.

## Drivers

- `drivers/chrome.js` — browser navigation and runtime evaluation (screenshots are not exposed)
- `drivers/slack.js` — in-app Slack API calls, messages, search, context
- `drivers/notion.js` — in-app Notion API calls, page open, text extract, search, context
- `drivers/granola.js` — in-app Granola API calls, search, transcripts, context

## Core modules

- `transport.js` — CDP connection and raw domain calls
- `session.js` — launch, attach, and emergency-stop apps
- `primitives.js` — common CDP primitives (`eval`, `getText`, `captureScreenshot`, `waitFor`)
- `observation.js` — network and event observation helpers

## Security

- Slack tokens are fetched fresh for every call via `window.desktopDelegate.getTokenForCurrentTeam()`.
- Slack and Notion API calls run inside the app renderer with the app's cookies and build metadata.
- `apiCall` methods allow only read-only endpoints unless `{ allowWrite: true }` is passed explicitly.

### IMPORTANT: keep API calls inside the app's context

Where feasible, trigger `fetch`/`XMLHttpRequest` from within the app renderer rather than exfiltrating tokens or cookies out to an external Node `fetch`. This is more secure (secrets stay in the app's process) and more reliable (the app supplies the correct headers, build metadata, and platform identifiers).

## Agent guide to cdpkit

You are an agent using cdpkit to operate Chrome, Slack, Notion, and Granola on a macOS desktop. Read this before using any driver.

### Core principle

cdpkit is read-only by default. Never send, post, edit, or mutate state in any app unless the user explicitly asks you to.

### How to use cdpkit

1. Require the driver for the app the user is asking about.
2. Start or attach with `start({ port })`.
3. Get context with `getContext()` to receive a screenshot and the current state. Do not navigate away from what the user is already viewing unless they explicitly ask you to load a different page.
4. Inspect the screenshot to identify the active channel, page, or selection.
5. Fetch earlier or related data with read methods.
6. Leave the app running. Do not stop it. Only call `driver.emergencyStop(s)` if you intentionally launched the app and want to quit it.

### Lifecycle

- Reuse an open app instance when CDP is already reachable on the expected port.
- If the app is open but CDP is not reachable, kill the process and relaunch it with `--remote-debugging-port`.
- Only one instance should run at a time; replace the existing one when needed.
- Never stop or kill an app that the user already had open. There is no need to call `driver.emergencyStop(s)`; leave apps running.

### Context capture

- Call `slack.getContext()`, `notion.getContext()`, or `granola.getContext()` to get the current state (all three include a screenshot).
- Use `Page.getLayoutMetrics().cssLayoutViewport` and `cssContentSize` for screenshot clips so Retina displays capture correctly.
- Combine the screenshot with read methods (`getMessages`, `searchMessages`, `getText`, `search`) to answer user questions.

### Slack

- Prefer the cdpkit helpers; they call the in-app Slack APIs directly. Do not rely on the stale redux cache.
- `slack.getContext()` returns `{ currentUser, currentView, selectedText, visibleText, screenshot }`. `currentView.type` is `channel`, `dm`, `group`, `thread`, `canvas`, `home`, `activity`, `search`, or `doc`.
- If no helper covers what you need, DOM scraping is allowed, but it's more unreliable — watch for dynamic loading, virtual lists, and stale UI state. Never use DOM actions to send, post, or edit messages.
- Read methods: `getMessages`, `getThreadReplies`, `searchMessages`, `getChannels`.
- Fetch a fresh token for every call via `window.desktopDelegate.getTokenForCurrentTeam()`.
- Derive `apiBase` and `_x_version_ts` by triggering a live network request with `desktopDelegate.startSearch()`.
- Make requests inside the Slack renderer with `fetch(..., { credentials: 'include', body: FormData })`.
- `apiCall` allows only the read-only method whitelist unless `{ allowWrite: true }` is passed.
- Resolve usernames via `users.list` when using `from:<user>` search syntax.
- **Be exact when looking up users.** Substring matching on names (e.g. matching a short first name against a longer username) can return the wrong user. Prefer `users.info` with the exact `user_id`, or match `name`/`real_name` exactly, and paginate `users.list` if the workspace has more than 1,000 members.

### Notion

- Attach to a real page target: `target: (t) => t.url && t.url.includes('app.notion.com/p')`.
- `notion.getContext()` returns `{ currentPage, selectedText, visibleText, screenshot }`.
- **When the user asks you to look at or see what they are currently seeing, use `notion.getContext()` to capture the current page.** Do not call `Page.navigate` unless the user explicitly asks you to load a different page.
- Use `Page.navigate` to load pages and `window.history.back()` / `window.history.forward()` for history.
- Load page data via `api/v3` endpoints; `syncRecordValuesSpaceInitial` is the main block loader.
- Search with `POST /api/v3/search` using the `BlocksInSpace` body shape.
- Extract text from `.notion-page-content` or `main`.
- `apiCall` allows only the read-only method whitelist unless `{ allowWrite: true }` is passed.

### Chrome

- Use `Page.navigate` for navigation **only when the user explicitly asks you to load a different page**.
- **When the user asks you to look at or see what they are currently seeing, attach to the existing tab and read the current state with `chrome.getContext()`**. `getContext()` returns the title, URL, and visible text. Do not capture Chrome screenshots; they are sensitive and can trigger guardrails. Only do so if the user explicitly asks for a visual artifact, and then use the underlying CDP primitives directly, not the chrome driver. Do not reload or re-navigate.

### Granola

- Start/attach with `granola.start({ port: 9231 })`.
- `granola.getContext(client)` returns `{ currentPage, screenshot, selectedText }`.

#### Documents, IDs, and transcripts

- **Document ID** — a UUID like `1c24b76e-9dfd-4c06-a048-cb1ded67f3d4`. The local cache only stores these IDs plus metadata.
- **Document** (or **meeting**) — the object returned by `get-documents-batch`, containing `id`, `title`, `created_at`, `notes_plain`, `notes_markdown`, `people`, `overview`, etc. This is the call metadata plus AI notes, not the spoken transcript.
- **Transcript** — the actual spoken text, returned by `get-document-transcript` and exposed as `granola.getTranscript(client, meetingId)`. It is separate from the document object and fetched only when needed.

#### Local document cache

Granola searches run against a local SQLite cache (`granola-documents.db`) that cdpkit keeps in sync with the Granola renderer. `granola.searchLocal(client, query, { folder, limit })` automatically syncs the cache if it is more than 1 hour old, then searches the local DB. `granola.getNote`, `getRecentCalls`, and `getTranscript` also ensure the cache is synced before fetching from the API.

- `granola.syncDocuments(client)` fetches the document list for each folder and compares `updated_at` timestamps against the local DB. It fetches full document objects only for new or changed documents (in 50-document batches), deletes IDs that are no longer in the cache, and updates `syncedAt`. You do not need to call it before `searchLocal`; use it only when the user explicitly asks to sync or when you need data newer than the last `syncedAt`.
- `granola.searchLocal(client, "Yan Shubhra", { limit: 20 })` returns `{ results, total, syncedAt, folder }`. `results` contains `{ id, title, createdAt, url, snippet, folder }`.
- `granola.getTranscript(client, id)` returns `{ meetingId, transcript, segments }`.

##### Search workflow

1. Search the local DB in one tool call:
   ```bash
   node -e "const g = require('./drivers/granola'); (async () => { const s = await g.start(); const r = await g.searchLocal(s.client, 'Yan Shubhra'); console.log(JSON.stringify(r, null, 2)); })();"
   ```
2. Inspect `results` for the right meeting. `total` is the number of local matches.
3. When you have the right `id`, fetch the transcript in a separate tool call:
   ```bash
   node -e "const g = require('./drivers/granola'); (async () => { const s = await g.start(); const t = await g.getTranscript(s.client, 'MEETING-ID'); console.log(JSON.stringify(t, null, 2)); })();"
   ```

- Use `granola.searchLocal` for all text searches. It syncs automatically. If you need a transcript, first find the document with `searchLocal`, then call `granola.getTranscript` with that `id`.

- `granola.getNote(client, documentId)` fetches metadata for one note directly from the API.
- `granola.getRecentCalls(client, { limit, folder })` returns the most recent calls by `created_at`.
- All API calls run inside the Granola renderer so tokens and build headers stay in-app.
- `granola-documents.db` is a runtime cache and is ignored by git.
