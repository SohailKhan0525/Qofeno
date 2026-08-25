# Privacy Model

## Where your data lives

Everything Qofeno stores is under one directory: `~/.qofeno/`

```
qofeno.db        sessions, messages, memory, knowledge index (SQLite/WAL)
blobs/           content-addressed attachments
credentials/     OS keyring integration or AES-GCM vault
config/          layered JSON configs, trust store
cache/, logs/    disposable
```

Run `qofeno privacy` anytime for a live map, including configured provider endpoints.

## What leaves your machine

Nothing, unless a request requires an AI provider you explicitly configured:

- **Local providers (Ollama)** — inference happens on your hardware; prompts go to localhost.
- **Hosted providers (OpenAI-compatible/Anthropic)** — the conversation context for that request is sent to that endpoint. Classification policy blocks `sensitive`/`local-only` content from ever being routed there; routing refuses silent fallback to another provider for protected data.
- **Telemetry** — none. No analytics endpoint exists in the codebase.

`qofeno config set security.localOnly true` makes the platform refuse any external destination entirely.

## Your controls

| Right | How |
|---|---|
| See stored data | `~/.qofeno/qofeno.db`, `/api/*` endpoints, `qofeno sessions list` |
| Delete one thing | `qofeno sessions rm <id>`, `qofeno memory forget <id>` |
| Delete everything | `rm -rf ~/.qofeno` (documented; no hidden copies exist) |
| Export (open format) | `qofeno sessions export <id> [path]` — documented `qofeno.session/1` JSON |
| Inspect network posture | `qofeno doctor`, `qofeno privacy` |

Deleted rows are removed from SQLite and its FTS indexes; backups you create retain their copy until you delete them (documented behavior, not hidden).
