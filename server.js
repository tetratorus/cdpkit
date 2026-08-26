const http = require("http");
const url = require("url");
const granola = require("./drivers/granola");

const PORT = process.env.PORT || 8787;

function json(res, data, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return json(res, { ok: true }, 204);
  }
  if (req.method !== "GET") {
    return json(res, { error: "only GET is supported" }, 405);
  }

  const parsed = url.parse(req.url, true);
  const { pathname, query } = parsed;

  try {
    switch (pathname) {
      case "/":
        return json(res, { ok: true, app: "granola", endpoints: ["/recent", "/search", "/note", "/transcript"] });

      case "/recent": {
        const limit = parseInt(query.limit, 10) || 10;
        const result = await granola.getRecentCalls({ limit });
        return json(res, result);
      }

      case "/search": {
        if (!query.q) return json(res, { error: "missing q" }, 400);
        const limit = parseInt(query.limit, 10) || 10;
        const result = await granola.searchNotes(query.q, { limit });
        return json(res, result);
      }

      case "/note": {
        if (!query.id) return json(res, { error: "missing id" }, 400);
        const result = await granola.getNote(query.id);
        return json(res, result);
      }

      case "/transcript": {
        if (!query.id) return json(res, { error: "missing id" }, 400);
        const result = await granola.getTranscript(query.id);
        return json(res, result);
      }

      default:
        return json(res, { error: "not found" }, 404);
    }
  } catch (err) {
    let message = err.message;
    try {
      const parsed = JSON.parse(message);
      return json(res, parsed, 500);
    } catch {
      return json(res, { error: message }, 500);
    }
  }
});

server.listen(PORT, () => {
  console.log(`Granola HTTP server listening on http://127.0.0.1:${PORT}`);
});
