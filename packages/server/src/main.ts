import { startServer } from "./server.js";
import { join } from "node:path";

const port = Number(process.env.QOFENO_PORT ?? 7931);
const token = process.env.QOFENO_API_TOKEN;
const { dir } = await import("node:url").then((u) => ({ dir: join(u.fileURLToPath(new URL(".", import.meta.url))) }));
await startServer({ port, apiToken: token, staticDir: join(dir, "web") });
console.log(`qofeno server listening on http://127.0.0.1:${port}${token ? " (auth: bearer token)" : ""}`);
