const probe = require("../probe");
const state = require("../state");

async function main() {
  const host = process.argv[2] || "127.0.0.1";
  const port = parseInt(process.argv[3] || "9229", 10);

  console.log(`Probing CDP at ${host}:${port}...`);

  try {
    const result = await probe.freshSocketProbe({ host, port });
    if (result.ok) {
      state.setLastWorking(host, port, { targetId: result.targetId, latencyMs: result.latencyMs });
      console.log("OK", {
        latencyMs: result.latencyMs,
        targetId: result.targetId,
        targetUrl: result.target && result.target.url,
        targetTitle: result.target && result.target.title,
        lastWorkingAt: new Date(state.getLastWorkingAt(host, port)).toISOString(),
      });
      process.exit(0);
    } else {
      state.setLastFailure(host, port, result.error);
      console.error("PROBE_FAILED", result.error && result.error.message);
      process.exit(1);
    }
  } catch (err) {
    state.setLastFailure(host, port, err);
    console.error("PROBE_FAILED", err.message);
    process.exit(1);
  }
}

main();
