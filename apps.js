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
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    killCmd:
      'killall -TERM "Google Chrome" 2>/dev/null; killall -TERM "Google Chrome Helper" 2>/dev/null; for i in $(seq 1 20); do sleep 0.5; pgrep -x "Google Chrome" >/dev/null 2>&1 || exit 0; done; killall -9 "Google Chrome" 2>/dev/null; killall -9 "Google Chrome Helper" 2>/dev/null',
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
      `${home}/Applications/Granola-cdp.app/Contents/MacOS/Granola`,
      `--granola-cdp-token=x`,
      `--remote-debugging-port=${port}`,
    ],
    killCmd:
      'pkill -TERM -f "Granola-cdp.app" 2>/dev/null; sleep 1; pkill -9 -f "Granola-cdp.app" 2>/dev/null',
    defaultPort: 9231,
  },
  teams: {
    name: "Microsoft Teams",
    processName: "MSTeams",
    launchArgs: (port) => [
      "/usr/bin/env",
      `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      "/Applications/Microsoft Teams.app/Contents/MacOS/MSTeams",
    ],
    killCmd: "pkill -TERM -x MSTeams",
    defaultPort: 9232,
  },
};

module.exports = { apps };
