/**
 * Qofeno Server (#0079/#0080/#0144-#0146): optional self-hosted HTTP API
 * exposing sessions, chat, memory, knowledge, tools and health. Zero
 * dependencies; hardened defaults (rate limiting, body caps, security
 * headers, no secrets in responses).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RateLimiter, redactSecrets } from "@agent-qofeno/security";

export interface ServerOptions {
  port: number;
  host?: string;
  /** Shared secret for bearer auth; omit to bind localhost-only without auth. */
  apiToken?: string;
  staticDir?: string;
}

export interface RouteHandler {
  (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body: unknown): Promise<void> | void;
}

export class QofenoServer {
  private routes = new Map<string, RouteHandler>();
  private limiter = new RateLimiter(240, 240 / 60);

  constructor(private opts: ServerOptions) {}

  route(method: string, path: string, handler: RouteHandler): void {
    this.routes.set(`${method} ${path}`, handler);
  }

  /** Match `/api/sessions/:id/messages` style patterns. */
  private match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    for (const [key, handler] of this.routes) {
      const [m, pattern] = key.split(" ");
      if (m !== method) continue;
      const pp = pattern!.split("/").filter(Boolean);
      const ap = pathname.split("/").filter(Boolean);
      if (pp.length !== ap.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < pp.length; i++) {
        const seg = pp[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(ap[i]!);
        else if (seg !== ap[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler, params };
    }
    return null;
  }

  listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    return new Promise((resolve) => {
      server.listen(this.opts.port, this.opts.host ?? "127.0.0.1", () => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Security headers on everything.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'");
    res.setHeader("Referrer-Policy", "no-referrer");

    if (!this.limiter.tryConsume()) {
      res.writeHead(429, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "rate limited" }));
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (this.opts.apiToken && pathname.startsWith("/api/")) {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${this.opts.apiToken}`;
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
        res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    if (pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      return;
    }

    const found = this.match(req.method ?? "GET", pathname);
    if (!found) {
      if (req.method === "GET" && !pathname.startsWith("/api/") && this.opts.staticDir) {
        await this.serveStatic(pathname, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not found" }));
      return;
    }

    let body: unknown;
    if (req.method === "POST" || req.method === "PUT") {
      body = await readJsonBody(req, 2_000_000);
      if (body === undefined) {
        res.writeHead(413, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "body too large or invalid JSON" }));
        return;
      }
    }

    try {
      await found.handler(req, res, found.params, body);
    } catch (e) {
      const message = redactSecrets(e instanceof Error ? e.message : String(e));
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    }
  }

  private async serveStatic(pathname: string, res: ServerResponse): Promise<void> {
    const rel = pathname === "/" ? "/index.html" : pathname;
    if (rel.includes("..")) {
      res.writeHead(400).end();
      return;
    }
    const file = join(this.opts.staticDir!, rel);
    if (!existsSync(file)) {
      // SPA fallback
      const index = join(this.opts.staticDir!, "index.html");
      if (existsSync(index)) {
        res.writeHead(200, { "Content-Type": "text/html" }).end(await readFile(index));
        return;
      }
      res.writeHead(404).end("not found");
      return;
    }
    const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" }).end(await readFile(file));
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return ha.equals(hb);
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        resolve(undefined);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", () => resolve(undefined));
  });
}
