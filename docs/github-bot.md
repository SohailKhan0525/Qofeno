# GitHub Bot Setup

`@agent-qofeno/github-bot` is a real GitHub App service: it verifies webhooks with HMAC-SHA256 (constant time), authenticates as the App with RS256 JWTs, exchanges installation tokens per event, and automates issue/PR hygiene with minimum permissions.

## Create the GitHub App

1. github.com → Settings → Developer settings → **New GitHub App**.
2. Webhook URL: `https://your-host/webhook`, secret: generate `openssl rand -hex 32`.
3. **Minimum permissions**: Contents: Read · Issues: Read & write · Pull requests: Read & write.
4. Subscribe to **Issue comment** only.
5. Download the private key (.pem).

## Run

```bash
export QOFENO_GH_APP_ID=123456
export QOFENO_GH_PRIVATE_KEY="$(cat app.private-key.pem)"
export QOFENO_GH_WEBHOOK_SECRET=…
qofeno-bot        # or: node packages/github-bot/dist/src/main.js
```

Listens on `127.0.0.1:7932` — terminate TLS at your proxy.

## Commands (comment on any issue/PR)

```
/qofeno help
/qofeno summarize     PR size/risk summary (files, +/-, size class)
/qofeno checklist     review checklist comment
```

## Guarantees

- Forged deliveries rejected before parsing (signature check).
- Fast 202 ack; processing errors never leak internals to GitHub.
- Bot comments carry an HTML marker (`<!-- qofeno-bot v0.1 -->`) so they are identifiable and deduplicable.
