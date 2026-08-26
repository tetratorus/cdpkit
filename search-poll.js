const sp = require("./search-process");

const filePath = process.argv[2];
const timeoutMs = Number(process.argv[3]) || 30000;

if (!filePath) {
  console.error("Usage: node search-poll.js <filePath> [timeoutMs]");
  process.exit(1);
}

(async () => {
  const status = await sp.longPollFile(filePath, timeoutMs);
  console.log(JSON.stringify(status, null, 2));
})();
