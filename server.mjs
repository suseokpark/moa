import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 4173);
const demo = "/extension/notion-favorite-sections/sidepanel/sidepanel.html";
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};

const server = createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end("Method not allowed");
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname.includes("\\") || pathname.split("/").some(part => part.startsWith("."))) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const file = resolve(root, `.${pathname === "/" ? demo : pathname}`);
    const within = relative(root, file);
    if (within.startsWith("..") || isAbsolute(within)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": types[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(file).on("error", () => response.destroy()).pipe(response);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 400).end("Unavailable path");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`FAVMOA preview: http://127.0.0.1:${port}`);
});
