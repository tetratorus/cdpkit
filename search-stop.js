const sp = require("./search-process");

const pid = process.argv[2];

if (!pid) {
  console.error("Usage: node search-stop.js <pid>");
  process.exit(1);
}

const stopped = sp.stopSearchProcess(Number(pid));
console.log(JSON.stringify({ stopped }));
