// The game server: one long-running Node process that owns every room's
// match, speaks WebSocket at /ws, and serves the statically exported
// Next.js app (out/) plus /readme/. Next.js is the app shell; it never owns
// the simulation loop.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { marked } from "marked";
import { MAX_MESSAGE_BYTES } from "../shared/protocol.ts";
import { TICK_MS } from "../shared/content.ts";
import { attach, createNewRoom, fillOf, roomCount, saveAll, stats, stepAll } from "./rooms.ts";
import { pruneRooms } from "./store.ts";

const PORT = Number(process.env.PORT ?? 8080);
const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "out");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Same check the old scroll used: a write from another site's page is refused. */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Fly's proxy names the real client; locally it's the socket's peer. */
const clientIp = (req: IncomingMessage): string => {
  const fly = req.headers["fly-client-ip"];
  return (typeof fly === "string" && fly) || req.socket.remoteAddress || "unknown";
};

// at most ROOMS_PER_HOUR new rooms per address: each one is a stored row
const ROOMS_PER_HOUR = 60;
const created = new Map<string, number[]>();
function mayCreateRoom(ip: string): boolean {
  const hourAgo = Date.now() - 3_600_000;
  const recent = (created.get(ip) ?? []).filter((t) => t > hourAgo);
  if (recent.length >= ROOMS_PER_HOUR) return false;
  recent.push(Date.now());
  created.set(ip, recent);
  return true;
}

async function readme(): Promise<string> {
  const body = await marked.parse(await readFile(join(ROOT, "README.md"), "utf8"));
  return `<!doctype html>
<html lang="en-AU">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>About Kiln</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1.2rem;color:#2b2a33;background:#fdf8ec}a{color:#2a6b4a}code{background:#f0e8d4;padding:0 .2em;border-radius:3px}pre{background:#f0e8d4;padding:.8rem;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #d9cfb5;padding:.3rem .5rem}</style>
</head><body><p><a href="/">&larr; back to Kiln</a></p><main>
${body}
</main></body></html>`;
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(OUT, rel));
  if (!file.startsWith(OUT)) return false;
  const candidates = extname(file) ? [file] : [file, `${file}.html`, join(file, "index.html")];
  for (const f of candidates) {
    try {
      if (!(await stat(f)).isFile()) continue;
      const immutable = rel.startsWith("/_next/static/");
      res.writeHead(200, {
        "content-type": TYPES[extname(f)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      res.end(await readFile(f));
      return true;
    } catch {
      // try the next candidate
    }
  }
  return false;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/readme" || url.pathname === "/readme/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readme());
    }
    if (url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        rooms: roomCount(),
        tickMsLast: +stats.tickMsLast.toFixed(2),
        tickMsMax: +stats.tickMsMax.toFixed(2),
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
        bytesOut: stats.bytesOut,
        msgsIn: stats.msgsIn,
        uptimeS: Math.round(process.uptime()),
      });
    }
    if (url.pathname === "/api/rooms") {
      if (req.method !== "POST") return json(res, 405, { error: "POST only" });
      if (!sameOrigin(req)) return json(res, 403, { error: "cross-site request refused" });
      if (!mayCreateRoom(clientIp(req))) return json(res, 429, { error: "too many new rooms: try again later" });
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_MESSAGE_BYTES) return json(res, 413, { error: "too large" });
        chunks.push(chunk as Buffer);
      }
      let body: unknown = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      } catch {
        return json(res, 400, { error: "malformed JSON" });
      }
      const bots = fillOf((body as { bots?: unknown } | null)?.bots);
      return json(res, 201, { code: createNewRoom(bots), bots });
    }
    if (req.method === "GET" || req.method === "HEAD") {
      if (await serveStatic(url.pathname, res)) return;
      if (await serveStatic("/404.html", res)) return;
    }
    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws" || !sameOrigin(req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, clientIp(req)));
});

// wake twice a tick; stepAll runs however many whole ticks are due
const loop = setInterval(stepAll, TICK_MS / 2);
pruneRooms();
setInterval(pruneRooms, 3_600_000).unref();

function shutdown(signal: string): void {
  console.log(`${signal}: saving rooms and closing`);
  clearInterval(loop);
  saveAll();
  for (const ws of wss.clients) ws.close(1012, "server restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, "0.0.0.0", () => console.log(`Kiln listening on :${PORT}`));
