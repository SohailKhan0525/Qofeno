# Self-Hosting the Qofeno App

`qofeno serve` exposes the same engines over HTTP for a laptop, homelab or team server.

## Run

```bash
QOFENO_API_TOKEN=$(openssl rand -hex 24) qofeno serve --port 7931 --token "$QOFENO_API_TOKEN"
```

- Binds `127.0.0.1` by default; put a TLS reverse proxy (Caddy/nginx) in front for remote use.
- With a token set, all `/api/*` routes require `Authorization: Bearer …` (constant-time comparison).
- Security headers (CSP, nosniff, frame-deny), rate limiting and JSON body caps are always on.

## Docker

```bash
docker build -t qofeno .
docker run -p 7931:7931 \
  -v qofeno-data:/data \
  -e QOFENO_HOME=/data \
  -e QOFENO_API_TOKEN=change-me \
  qofeno
```

The image runs as non-root, contains only compiled JS + Node.

## API surface

```
GET    /healthz
GET    /api/models
GET|POST /api/sessions
GET|POST /api/sessions/:id/messages
POST   /api/chat                 { prompt, modelId? } → policy-routed completion
GET|POST /api/memory             DELETE /api/memory/:id
POST   /api/tools/:name          fail-closed tool invocation
GET    /api/events               recent audit records
```

## Multi-user notes

The App currently assumes one data directory per deployment. For team deployments run one container per user, or place an authenticating proxy that maps users to separate `QOFENO_HOME`s — this preserves strict data isolation until native multi-user lands (tracked in CHANGELOG).

## Backups

Back up the whole `QOFENO_HOME`. SQLite is in WAL mode; use `sqlite3 .backup` or filesystem snapshots for consistency. Restore = stop the server, replace the directory, start.
