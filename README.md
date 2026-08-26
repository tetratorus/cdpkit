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
5. Stop the session: `driver.stop(s)`.

## Drivers

- `drivers/chrome.js` — browser navigation and runtime evaluation (screenshots are not exposed)
- `drivers/slack.js` — in-app Slack API calls, messages, search, context
- `drivers/notion.js` — in-app Notion API calls, page open, text extract, search, context
- `drivers/granola.js` — in-app Granola API calls, search, transcripts, context

## Core modules

- `transport.js` — CDP connection and raw domain calls
- `session.js` — launch, attach, and stop apps
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
2. Start or attach with `start({ port, kill })`.
3. Get context with `getContext()` to receive a screenshot and the current state. Do not navigate away from what the user is already viewing unless they explicitly ask you to load a different page.
4. Inspect the screenshot to identify the active channel, page, or selection.
5. Fetch earlier or related data with read methods.
6. Stop the session with `stop()`.

### Lifecycle

- Reuse an open app instance when CDP is already reachable on the expected port.
- If the app is open but CDP is not reachable, kill the process and relaunch it with `--remote-debugging-port`.
- Only one instance should run at a time; replace the existing one when needed.

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

#### Searching

All Granola text searches must go through the `search-*.js` scripts. Do not call `granola.search` directly from the AI; it is a one-shot internal helper used only by `search-worker.js`.

##### Happy-path workflow

Each step below is one tool call. Do not combine them into a single script.

1. Start: `node search-start.js "Anurag"` prints `{ pid, filePath }`.
2. Poll: `node search-poll.js <filePath>` blocks until the worker either finds a new match, finishes scanning, errors, or the 30s timeout elapses. It prints the current state.
3. Inspect `results` from the poll output. `results` accumulates every match the worker has found so far, not only the latest batch. Check whether the *specific* meeting you need is in there.
4. If the meeting is found, run `node search-stop.js <pid>` to kill the worker, then use `granola.getTranscript(client, id)` or `granola.getNote(client, id)`.
5. If the meeting is not found and `complete` is `false`, go back to step 2 with another `node search-poll.js <filePath>` call.
6. If the meeting is not found and `complete` is `true`, the worker has already finished. Run `node search-stop.js <pid>` and report that the meeting is not in Granola.

##### Failure modes (what can go wrong and why)

**1. Stopping at the first non-empty `results`**  
`search-poll.js` returns as soon as the worker has found *any* new match, not necessarily the one you want. The first match might be a different meeting that happens to contain the keyword in a snippet. Because `results` accumulates matches from every batch, you must keep polling until the specific meeting (right title and/or ID) appears, or until `complete` is `true`.

**2. Writing one long-blocking script instead of separate tool calls**  
A script like `node -e "... while(true) { await searchPoll(...) } ..."` defeats the design. It holds a single tool call open for a long time, the Devin `exec` timeout may kill it before `search-stop.js` runs, and the worker is left orphaned with no way to stop it. Each search step — `search-start.js`, `search-poll.js`, `search-stop.js` — must be its own tool call. The AI must look at the output of one tool call before issuing the next.

**3. Forgetting to run `search-stop.js`**  
The worker is a detached background process. If you do not run `search-stop.js <pid>` when you are done, it will keep scanning until the cache is exhausted, and it may hold the CDP session open. Even when `complete` is `true` the process is still alive until `search-stop.js` is called. Always run `search-stop.js` after the last poll.

**4. Using a tool timeout that is shorter than the poll timeout**  
`search-poll.js` defaults to 30s. If the `exec` timeout is shorter (for example, the 10s default), the tool call is killed before `search-poll.js` can return the state, so you never see the result and cannot know whether the worker found anything. Use an `exec` timeout of at least 45s for a `search-poll.js` call. If the worker finds a result earlier, it returns immediately.

**5. Calling `granola.search` directly**  
`granola.search` is one-shot and returns a `resume` token. It is not meant to be called by the AI. It is used internally by `search-worker.js` to advance the background scan. Always use `search-start.js`, `search-poll.js`, and `search-stop.js`.

**6. Misinterpreting `complete: true`**  
`complete: true` means the worker has scanned all document IDs. If your target is not in `results` at that point, it is genuinely not in the cache. Do not keep starting new searches; you have the final answer.

**7. Starting multiple searches without stopping previous workers**  
Each `search-start.js` creates a new worker with a new `pid` and `filePath`. If you start a new search before stopping the old one, you will have multiple workers attached to Granola and possibly competing for the cache. Stop the previous worker before starting another.

- `granola.checkCacheFreshness(client, { folder })` compares the cache's `updated_at` for each folder against the server's `get-document-list` response and returns `{ fresh, lists }`. Call this before `search` if you want to verify the cache is up to date.
- `granola.getNote(client, documentId)` fetches metadata for one note.
- `granola.getRecentCalls(client, { limit, folder })` returns the most recent calls by `created_at`.
- `granola.getTranscript(client, meetingId)` returns `{ meetingId, transcript, segments }`.
- All API calls run inside the Granola renderer so tokens and build headers stay in-app.
