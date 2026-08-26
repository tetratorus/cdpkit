const fs = require("fs").promises;
const path = require("path");
const granola = require("./drivers/granola");

const [filePath, keyword, folder] = process.argv.slice(2);

async function writeState(state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
}

async function main() {
  const startedAt = Date.now();
  await writeState({
    status: "starting",
    keyword,
    folder,
    total: null,
    searched: 0,
    progressPercentage: 0,
    results: [],
    complete: false,
    startedAt,
  });

  const s = await granola.start({ port: 9231, kill: false });
  let resume = null;
  const allResults = [];

  async function cleanup() {
    try {
      await granola.stop(s);
    } catch {}
    process.exit(1);
  }
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  try {
    while (true) {
      const page = await granola.search(s.client, keyword, { folder, resume });
      allResults.push(...page.results);
      await writeState({
        status: "running",
        keyword,
        folder,
        total: page.total,
        searched: page.searched,
        progressPercentage: page.progressPercentage,
        results: allResults,
        complete: !page.resume,
        startedAt,
      });
      if (!page.resume) break;
      resume = page.resume;
    }
    await writeState({
      status: "done",
      keyword,
      folder,
      total: page.total,
      searched: page.searched,
      progressPercentage: 100,
      results: allResults,
      complete: true,
      startedAt,
    });
  } catch (err) {
    await writeState({
      status: "error",
      keyword,
      folder,
      error: err.message,
      results: allResults,
      complete: true,
    });
  } finally {
    try { await granola.stop(s); } catch {}
    process.exit(0);
  }
}

main();
