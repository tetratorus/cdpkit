const fs = require('fs');
const path = require('path');
const slack = require('../drivers/slack');
const primitives = require('../primitives');

// Convert an ArrayBuffer to a base64 string in chunks so we don't blow the stack.
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 32768;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function downloadFileFromChannel(channel, query, outDir) {
  const s = await slack();

  const search = await slack.searchMessages(s.client, `${query} in:#${channel}`, { count: 10 });
  const matches = (search.messages && search.messages.matches) || [];
  const message = matches.find(m => m.files && m.files.length > 0);
  if (!message) throw new Error(`No message with files found for: ${query} in #${channel}`);

  const file = message.files.find(f => f.name && f.name.toLowerCase().includes(query.toLowerCase())) || message.files[0];
  const url = file.url_private_download || file.url_private;
  const outPath = path.resolve(outDir, file.name);

  console.log(`Found: ${file.name} (${file.size} bytes)`);
  console.log(`URL: ${url}`);
  console.log(`Downloading to: ${outPath}`);

  // All credentials stay inside Slack's renderer; the request uses the browser cookie jar.
  const b64 = await primitives.eval(
    s.client,
    `(async function(){
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!res.ok) throw new Error('Slack file fetch failed: ' + res.status + ' ' + res.statusText);
      const buf = await res.arrayBuffer();
      return (${toBase64.toString()})(buf);
    })()`,
    { returnByValue: true, awaitPromise: true }
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  console.log(`Saved: ${outPath} (${fs.statSync(outPath).size} bytes)`);
}

const [channel, query, outDir] = process.argv.slice(2);
if (!channel || !query) {
  console.error('Usage: node scripts/download_slack_file.js <channel-name> "<file-name-or-query>" [output-directory]');
  process.exit(1);
}

downloadFileFromChannel(channel, query, outDir || path.join(__dirname, '..', 'data')).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
