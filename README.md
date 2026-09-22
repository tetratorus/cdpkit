# cdpkit

A CDP toolkit for agents to observe and operate Chrome, Slack, Notion, Granola, and Microsoft Teams on the user's desktop.

## Setup

Requirements: macOS, Git, and Node.js 22.13 or newer with npm. Node.js 24 LTS is recommended. Install the desktop apps you want to use separately.

```bash
git clone https://github.com/tetratorus/cdpkit.git
cd cdpkit
npm ci
npm test
bash scripts/install-aliases.sh
source scripts/aliases.sh
```

The installer detects the clone location and adds the launcher source line to your zsh or bash configuration. You can pass a different shell configuration file as its first argument. New terminals then have the launchers available without sourcing them again.

| App | Launcher | CDP port |
| --- | --- | --- |
| Chrome | `chromestart` | 9229 |
| Slack | `slackstart` | 9228 |
| Notion | `notionstart` | 9230 |
| Microsoft Teams | `teamsstart` | 9232 |
| Granola | `granolastart` | 9231 |

Slack and Notion launchers can restart their apps to enable CDP. Chrome and Teams require you to quit an already-running non-CDP instance yourself. Granola requires a separately prepared CDP-enabled app copy; see `GRANOLA.md`. Granola setup is not required for the other apps. Launchers are intended for user invocation; agents must ask before restarting apps.

From the package directory, import the driver you need. For example, after running `teamsstart`:

```js
const { teams, transport } = require(".");

(async () => {
  const s = await teams();
  try {
    console.log(await teams.getContext(s.client));
  } finally {
    await transport.close(s.client);
  }
})();
```

No personal cache or exported data is needed for setup. `data/` is created when needed and is gitignored. Put one-off scripts in `data/scripts/` and local downloads, transcripts, caches, and generated artifacts in `data/`. Keep only maintained toolkit utilities and tests in `scripts/`.

## Agent workflow

1. Call the driver: `slack()`, `notion()`, `chrome()`, `granola()`, or `teams()`. Teams only attaches to an existing CDP endpoint.
2. Get context: `driver.getContext(client)` returns the current state. Slack, Notion, and Granola include a screenshot; Chrome and Teams return title, URL, and visible text.
3. Inspect the returned state to identify the active channel, page, or selection.
4. Fetch data with read methods like `getMessages`, `searchMessages`, `getText`, `search`, or Granola's `searchLocal`.
5. Leave the app running. There is no need to call `driver.emergencyStop(s)` unless you intentionally launched the app and want to quit it.

## Drivers

- `drivers/chrome.js` — browser navigation and runtime evaluation (screenshots are not exposed)
- `drivers/slack.js` — in-app Slack API calls, messages, search, context
- `drivers/notion.js` — in-app Notion API calls, page open, text extract, search, context
- `drivers/granola.js` — in-app Granola API calls, search, transcripts, context
- `drivers/teams.js`: native Microsoft Teams desktop attachment, target discovery, title, and visible text

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

You are an agent using cdpkit to operate desktop apps on macOS. Read this before using any driver.

### Core principle

cdpkit is read-only by default. Never send, post, edit, or mutate state in any app unless the user explicitly asks you to.

### How to use cdpkit

1. Require the driver for the app the user is asking about.
2. Call `driver({ port })` to start or attach according to that driver's lifecycle rules.
3. Get context with `driver.getContext(s.client)`. Do not navigate away from what the user is already viewing unless they explicitly ask you to load a different page.
4. Inspect the returned state to identify the active channel, page, or selection.
5. Fetch earlier or related data with read methods.
6. Leave the app running. Do not stop it. Only call `driver.emergencyStop(s)` if you intentionally launched the app and want to quit it.

### Lifecycle

- Reuse an open app instance when CDP is already reachable on the expected port.
- If the app is open but CDP is not reachable, ask the user to quit it or obtain explicit permission before restarting it with CDP enabled.
- Reuse the user's app instance rather than creating duplicate instances.
- Never stop an app the user already had open without permission. Close your CDP connection with `transport.close(s.client)` when finished; leave the app running.

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

Select a tab explicitly with `chrome({ port: 9229, target: { id: "TARGET_ID" } })`. Discover IDs with `transport.listTargets("127.0.0.1", 9229)`. The `target` option also accepts the existing URL/title selectors or predicate functions; they are resolved only on initial attachment. Omitting `target` retains the first-page default, not foreground-tab selection.

All transport clients now pin the selected target ID for reconnects, regardless of tab ordering or navigation. If that target disappears, commands fail with `CDP_TARGET_MISSING` without selecting another tab or restarting the app. Create a new session with an explicit replacement target. Selection belongs to the live client, not a directory-scoped state file; pass the target ID again in a new process. Reconnects still create a fresh CDP session, so connection-scoped settings must be re-enabled.

- Use `Page.navigate` for navigation **only when the user explicitly asks you to load a different page**.
- **When the user asks you to look at or see what they are currently seeing, attach to the existing tab and read the current state with `chrome.getContext()`**. `getContext()` returns the title, URL, and visible text. Do not capture Chrome screenshots; they are sensitive and can trigger guardrails. Only do so if the user explicitly asks for a visual artifact, and then use the underlying CDP primitives directly, not the chrome driver. Do not reload or re-navigate.

### Microsoft Teams desktop on macOS

Teams uses its bundled Edge/WebView2 runtime, not the Chrome app. The runtime accepts `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; the Teams launcher passes `--remote-debugging-port=9232 --remote-debugging-address=127.0.0.1` through this variable. This was verified on Teams `26225.1706.5101.3140` with WebView2 `152.0.4191.62`, without modifying the app bundle or extracting credentials.

From the cdpkit directory, the user can load the launcher and start Teams:

```bash
source scripts/aliases.sh
teamsstart
```

`teamsstart` reuses a reachable CDP endpoint or starts Teams from cold. If Teams is already running without CDP, it errors instead of quitting the app; the user must quit Teams first. Agents must not invoke shell launchers or restart Teams without explicit permission. CDP is unauthenticated and grants control of the app, so keep it on loopback and quit Teams when you want to stop exposing the endpoint.

The driver itself only attaches. It never launches, quits, or restarts Teams, including on reconnect failures:

```js
const teams = require("./drivers/teams");
const transport = require("./transport");

(async () => {
  const s = await teams();
  try {
    console.log(await teams.getContext(s.client));
  } finally {
    await transport.close(s.client);
  }
})();
```

- `teams.getContext(client)` returns `{ app: "teams", title, url, text }`. It does not take screenshots or call Teams service APIs.
- `teams.getTitle(client)` and `teams.getText(client)` read the selected page. Text includes only rendered content, not complete chat history or off-screen virtualized messages.
- Teams can expose several empty page targets alongside the real UI. Default selection probes only recognized Teams HTTPS pages, prefers a focused populated page, and otherwise requires exactly one populated page. If all pages are empty, wait for Teams to load and retry.
- If several populated pages match, the driver fails rather than selecting an arbitrary account or window. Use `await teams.listTargets()` and attach explicitly with `await teams({ target: { id: "TARGET_ID" } })`. Explicit URL, title, or predicate selectors must also resolve to exactly one Teams page.
- A non-default port can be passed to both `teams({ port })` and `teams.listTargets({ port })`. Reconnects remain pinned to the selected target ID; a closed target is never silently replaced.
- Close only the CDP connection with `transport.close(s.client)` when finished. Leave the user's Teams app running. No message-sending or mutation helpers are exposed.

### Granola

- Start/attach with `granola({ port: 9231 })`.
- `granola.getContext(client)` returns `{ currentPage, screenshot, selectedText }`.

#### Documents, IDs, and transcripts

- **Document ID** — a UUID like `1c24b76e-9dfd-4c06-a048-cb1ded67f3d4`. The local cache only stores these IDs plus metadata.
- **Document** (or **meeting**) — the object returned by `get-documents-batch`, containing `id`, `title`, `created_at`, `notes_plain`, `notes_markdown`, `people`, `overview`, etc. This is the call metadata plus AI notes, not the spoken transcript.
- **Transcript** — the actual spoken text, returned by `get-document-transcript` and exposed as `granola.getTranscript(client, meetingId)`. It is separate from the document object and fetched only when needed.

#### Local document cache

Granola searches run against a local SQLite cache (`data/granola-documents.db`) that cdpkit keeps in sync with the Granola renderer. `granola.searchLocal(client, query, { folder, limit })` automatically syncs the cache if it is more than 1 hour old, then searches the local DB. `granola.getNote`, `getRecentCalls`, and `getTranscript` also ensure the cache is synced before fetching from the API.

- `granola.syncDocuments(client)` fetches the document list for each folder and compares `updated_at` timestamps against the local DB. It fetches full document objects only for new or changed documents (in 50-document batches), deletes IDs that are no longer in the cache, and updates `syncedAt`. You do not need to call it before `searchLocal`; use it only when the user explicitly asks to sync or when you need data newer than the last `syncedAt`.
- `granola.searchLocal(client, "project planning", { limit: 20 })` returns `{ results, total, syncedAt, folder }`. `results` contains `{ id, title, createdAt, url, snippet, folder }`.
- `granola.getTranscript(client, id)` returns `{ meetingId, transcript, segments }`.

##### Search workflow

1. Search the local DB in one tool call:
   ```bash
   node -e "const g = require('./drivers/granola'); (async () => { const s = await g(); const r = await g.searchLocal(s.client, 'project planning'); console.log(JSON.stringify(r, null, 2)); })();"
   ```
2. Inspect `results` for the right meeting. `total` is the number of local matches.
3. When you have the right `id`, fetch the transcript in a separate tool call:
   ```bash
   node -e "const g = require('./drivers/granola'); (async () => { const s = await g(); const t = await g.getTranscript(s.client, 'MEETING-ID'); console.log(JSON.stringify(t, null, 2)); })();"
   ```

- Use `granola.searchLocal` for all text searches. It syncs automatically. If you need a transcript, first find the document with `searchLocal`, then call `granola.getTranscript` with that `id`.

- `granola.getNote(client, documentId)` fetches metadata for one note directly from the API.
- `granola.getRecentCalls(client, { limit, folder })` returns the most recent calls by `created_at`.
- All API calls run inside the Granola renderer so tokens and build headers stay in-app.
- `data/granola-documents.db` is a runtime cache and is ignored by git.

## Verification

Run `npm test` for the target-selection and reconnect regression tests. They use a local mock CDP server and stub state writes; they do not launch apps or touch the user's browser or saved state.
