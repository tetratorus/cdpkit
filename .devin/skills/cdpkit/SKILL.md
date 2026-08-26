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
await driver.stop(s);
```

To see what a driver exposes at runtime:

```bash
node -e "console.log(Object.keys(require('./drivers/granola')))"
```

## Granola search

All Granola text searches must go through `search-process.js`. Do not call `granola.search` directly from the AI.

```js
const sp = require("./search-process");
const { pid, filePath } = sp.startSearchProcess("keyword", { folder });
let status;
while (true) {
  status = await sp.longPollFile(filePath, 30000); // blocks until any result, completion, error, or timeout
  // inspect status.results for the specific document you need
  if (status.results.some(r => r.title.includes("right call")) || status.complete) break;
}
await sp.stopSearchProcess(pid);
```

- `startSearchProcess(keyword, { folder })` spawns a detached worker and returns `{ pid, filePath }`.
- `longPollFile(filePath, timeoutMs)` only returns when the worker has found any new match, finished, errored, or the timeout elapsed. **Do not stop at the first non-empty `results` — inspect the titles/IDs and keep calling `longPollFile` until the specific result you need appears or `complete` is `true`.
- `stopSearchProcess(pid)` kills the worker.

## Where to learn the API

- Implementation: `drivers/<app>.js` (slack.js, notion.js, chrome.js, granola.js)
- Lifecycle: `session.js` and `apps.js`
- Granola search worker: `search-process.js`, `search-worker.js`
- Low-level primitives: `primitives.js`, `transport.js`
- Overview: `README.md`

## Rules

- Read-only by default. `apiCall` rejects writes unless `{ allowWrite: true }` is passed.
- Do not post, send, edit, or mutate state in any app unless explicitly asked.
- Do not capture Chrome screenshots. They are sensitive and can trigger guardrails. Read the page with `getText`/`getTitle`/`getContext()` instead. Only capture a screenshot if the user explicitly asks for a visual artifact, and then use the underlying CDP primitives directly, not the chrome driver.
- For Granola, always use `search-process` and `longPollFile`; never loop `granola.search` directly.
