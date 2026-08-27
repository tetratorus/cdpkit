---
name: cdpkit
description: Drive Chrome/Slack/Notion on the user's desktop via the cdpkit package
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

## Dynamic loading

```js
const app = "slack"; // or "notion", "chrome"
const driver = require(`./drivers/${app}`);

const s = await driver.start();
const ctx = await driver.getContext(s.client);
console.log(JSON.stringify(ctx, null, 2));
// ... use driver helpers, e.g. driver.searchMessages, driver.search, driver.getText ...
// Leave the app running. There is no need to call driver.emergencyStop(s).
```

To see what a driver exposes at runtime:

```bash
node -e "console.log(Object.keys(require('./drivers/slack')))"
```

## Where to learn the API

- Implementation: `drivers/<app>.js` (slack.js, notion.js, chrome.js)
- Lifecycle: `session.js` and `apps.js`
- Low-level primitives: `primitives.js`, `transport.js`
- Overview: `README.md`

## Rules

- Read-only by default. `apiCall` rejects writes unless `{ allowWrite: true }` is passed.
- Do not post, send, edit, or mutate state in any app unless explicitly asked.
- Leave apps running. Do not call `driver.emergencyStop(s)` as a routine cleanup step. Only use `emergencyStop` when you intentionally launched the app and want to quit it.
