# cdpkit

A CDP toolkit for agents to observe and operate Chrome, Slack, and Notion on the user's desktop.

Import the driver for the app you need and call it from a Node script:

```js
const slack = require("./drivers/slack");
```

## Agent workflow

1. Start or attach to the app: `slack.start()` / `notion.start()` / `chrome.start()`.
2. Get context: `driver.getContext(client)` returns a screenshot and the current state.
3. Inspect the screenshot to identify the active channel, page, or selection.
4. Fetch data with read methods like `getMessages`, `searchMessages`, `getText`, `search`.
5. Stop the session: `driver.stop(s)`.

## Drivers

- `drivers/chrome.js` — browser navigation, screenshots, runtime evaluation
- `drivers/slack.js` — in-app Slack API calls, messages, search, context
- `drivers/notion.js` — in-app Notion API calls, page open, text extract, search, context

## Core modules

- `transport.js` — CDP connection and raw domain calls
- `session.js` — launch, attach, and stop apps
- `primitives.js` — common CDP primitives (`eval`, `getText`, `captureScreenshot`, `waitFor`)
- `observation.js` — network and event observation helpers

## Security

- Slack tokens are fetched fresh for every call via `window.desktopDelegate.getTokenForCurrentTeam()`.
- Slack and Notion API calls run inside the app renderer with the app's cookies and build metadata.
- `apiCall` methods allow only read-only endpoints unless `{ allowWrite: true }` is passed explicitly.

## Agent guide to cdpkit

You are an agent using cdpkit to operate Chrome, Slack, and Notion on a macOS desktop. Read this before using any driver.

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

- Call `slack.getContext()` or `notion.getContext()` to get a base64 PNG screenshot plus the current state.
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
- **When the user asks you to look at or see what they are currently seeing, attach to the existing tab and capture the current state.** Use `Runtime.evaluate` to inspect the page and `Page.captureScreenshot` for visual artifacts; do not reload or re-navigate.
