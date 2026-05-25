const http = require("http");
const fs = require("fs");
const path = require("path");

// Self-contained: serve everything from this directory.
const repoRoot = __dirname;
const port = Number(process.env.PORT || 8091);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wrl": "model/vrml",
  ".nc": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".tap": "text/plain; charset=utf-8",
  ".gcode": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function safeResolve(urlPathname) {
  const decodedPath = decodeURIComponent(urlPathname.split("?")[0]);
  const normalized = path.normalize(decodedPath).replace(/^([\\/])+/, "");
  const candidate = path.resolve(repoRoot, normalized);
  if (!candidate.startsWith(repoRoot)) {
    return null;
  }
  return candidate;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function handleFileStamp(req, res) {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, "http://localhost");
  } catch {
    sendJson(res, 400, { error: "Invalid URL" });
    return;
  }

  const repoPath = requestUrl.searchParams.get("path");
  if (!repoPath) {
    sendJson(res, 400, { error: "Missing path query parameter" });
    return;
  }

  const normalizedRepoPath = repoPath.startsWith("/") ? repoPath : `/${repoPath}`;
  const targetPath = safeResolve(normalizedRepoPath);
  if (!targetPath) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  fs.stat(targetPath, (err, stats) => {
    if (err || !stats.isFile()) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    sendJson(res, 200, {
      path: normalizedRepoPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
  });
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : req.url;
  const targetPath = safeResolve(requestPath);
  if (!targetPath) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  fs.stat(targetPath, (statError, stats) => {
    if (statError) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    const finalPath = stats.isDirectory() ? path.join(targetPath, "index.html") : targetPath;
    fs.stat(finalPath, (finalStatError, finalStats) => {
      if (finalStatError || !finalStats.isFile()) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const extension = path.extname(finalPath).toLowerCase();
      const contentType = mimeTypes[extension] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      fs.createReadStream(finalPath).pipe(res);
    });
  });
}

function handleSaveKinematics(req, res) {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) {
      req.destroy();
    }
  });

  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { error: "Invalid JSON payload" });
      return;
    }

    const outputPath = path.join(repoRoot, "data", "kinematics_inputs.json");
    fs.mkdir(path.dirname(outputPath), { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        sendJson(res, 500, { error: `Failed to create directory: ${mkdirErr.message}` });
        return;
      }

      fs.writeFile(outputPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8", (writeErr) => {
        if (writeErr) {
          sendJson(res, 500, { error: `Failed to write file: ${writeErr.message}` });
          return;
        }
        sendJson(res, 200, { ok: true, path: "data/kinematics_inputs.json" });
      });
    });
  });
}

function handleListNcFiles(res) {
  const ncDir = path.join(repoRoot, "nc_output");
  fs.readdir(ncDir, { withFileTypes: true }, (err, entries) => {
    if (err) {
      sendJson(res, 500, { error: `Failed to read nc_output: ${err.message}` });
      return;
    }
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.toLowerCase().endsWith(".nc"))
      .sort((a, b) => a.localeCompare(b));
    sendJson(res, 200, { files });
  });
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: "Missing URL" });
    return;
  }

  if (req.method === "POST" && req.url.startsWith("/api/save-kinematics")) {
    handleSaveKinematics(req, res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/nc-files")) {
    handleListNcFiles(res);
    return;
  }

  if (req.method === "GET" && req.url.startsWith("/api/file-stamp")) {
    handleFileStamp(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
});

server.on("error", (error) => {
  if (error && error.code === "EADDRINUSE") {
    console.log(`NC viewer already running at http://localhost:${port}/`);
    process.exit(0);
  }

  console.error(`Failed to start NC viewer server on port ${port}: ${error.message}`);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`NC viewer running at http://localhost:${port}/`);
});
