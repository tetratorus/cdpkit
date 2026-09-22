const { apps } = require("../apps");
const session = require("../session");
const transport = require("../transport");
const primitives = require("../primitives");

const TEAMS_HOSTS = new Set(["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft"]);

function isTeamsPage(target) {
  if (target.type !== "page") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "https:" && TEAMS_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function listTargets({ port = apps.teams.defaultPort } = {}) {
  const targets = await transport.listTargets("127.0.0.1", port);
  return targets.filter(isTeamsPage);
}

async function teams({ port = apps.teams.defaultPort, target } = {}) {
  let candidates = await listTargets({ port });
  if (target) candidates = candidates.filter(page => transport.findTarget([page], target));
  if (!candidates.length) {
    throw Object.assign(new Error("No matching Teams desktop page. Open Teams with teamsstart and check teams.listTargets()."), {
      code: "TEAMS_TARGET_MISSING",
    });
  }

  if (!target) {
    const ready = [];
    for (const page of candidates) {
      const { client } = await transport.connect({ host: "127.0.0.1", port, target: { id: page.id } });
      try {
        const state = await primitives.eval(client, "({ ready: !!(document.body && document.body.innerText.trim()), focused: document.hasFocus() })");
        if (state.ready) ready.push({ page, focused: state.focused });
      } finally {
        await transport.close(client);
      }
    }
    if (!ready.length) {
      throw Object.assign(new Error("Teams desktop is still loading or has no populated window. Retry after it loads, or pass an explicit target ID."), {
        code: "TEAMS_TARGET_NOT_READY",
      });
    }
    const focused = ready.filter(item => item.focused);
    candidates = (focused.length ? focused : ready).map(item => item.page);
  }

  if (candidates.length !== 1) {
    throw Object.assign(new Error(`Multiple Teams desktop pages match. Pass target: { id: "..." } from teams.listTargets(). IDs: ${candidates.map(page => page.id).join(", ")}`), {
      code: "TEAMS_TARGET_AMBIGUOUS",
    });
  }
  return session.attach({ host: "127.0.0.1", port, target: { id: candidates[0].id } });
}

async function getTitle(client) {
  return primitives.eval(client, "document.title");
}

async function getContext(client) {
  return primitives.eval(client, `({
    app: "teams",
    title: document.title,
    url: location.href,
    text: document.body ? document.body.innerText : ""
  })`);
}

teams.listTargets = listTargets;
teams.getTitle = getTitle;
teams.getText = primitives.getText;
teams.getContext = getContext;

module.exports = teams;
