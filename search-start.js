const sp = require("./search-process");

const keyword = process.argv[2];
const folder = process.argv[3];

if (!keyword) {
  console.error("Usage: node search-start.js <keyword> [folder]");
  process.exit(1);
}

const { pid, filePath } = sp.startSearchProcess(keyword, { folder });
console.log(JSON.stringify({ pid, filePath }));
