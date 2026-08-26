const os = require("os");

const home = os.homedir();
const chromeProfile = `${home}/.cdpkit-chrome`;

const apps = {
  chrome: {
    name: "Google Chrome",
    processName: "Google Chrome",
    launchArgs: (port) => [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `--user-data-dir=${chromeProfile}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    killCmd:
      'killall -TERM "Google Chrome" 2>/dev/null; killall -TERM "Google Chrome Helper" 2>/dev/null; sleep 1; killall -9 "Google Chrome" 2>/dev/null; killall -9 "Google Chrome Helper" 2>/dev/null',
    defaultPort: 9229,
  },
  slack: {
    name: "Slack",
    processName: "Slack",
    launchArgs: (port) => ["open", "-a", "Slack", "--args", `--remote-debugging-port=${port}`],
    killCmd: 'killall -TERM Slack 2>/dev/null; killall -9 Slack 2>/dev/null',
    defaultPort: 9228,
  },
  notion: {
    name: "Notion",
    processName: "Notion",
    launchArgs: (port) => ["open", "-a", "Notion", "--args", `--remote-debugging-port=${port}`],
    killCmd:
      'killall -TERM Notion 2>/dev/null; killall -TERM "Notion Helper" 2>/dev/null; sleep 1; killall -9 Notion 2>/dev/null; killall -9 "Notion Helper" 2>/dev/null',
    defaultPort: 9230,
  },
  granola: {
    name: "Granola",
    processName: "Granola",
    launchArgs: (port) => [
      "/Applications/Granola-cdp.app/Contents/MacOS/Granola",
      `--granola-cdp-token=x`,
      `--remote-debugging-port=${port}`,
    ],
    killCmd:
      'pkill -TERM -f "/Applications/Granola-cdp.app" 2>/dev/null; pkill -TERM -f "Granola Helper" 2>/dev/null; sleep 1; pkill -9 -f "/Applications/Granola-cdp.app" 2>/dev/null; pkill -9 -f "Granola Helper" 2>/dev/null',
    defaultPort: 9231,
  },
};

module.exports = { apps };
