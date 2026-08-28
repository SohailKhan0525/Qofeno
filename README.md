# Qofeno

**An open-source, terminal-native AI agent platform.** One repository, three products:

| Product | What it is | Entry point |
|---|---|---|
| **Qofeno Terminal CLI** | Professional terminal-native AI/agent/coding environment: interactive sessions, plan/review/execute modes, permission-enforced tools, local-first models | `qofeno` |
| **Qofeno App** | Complete graphical application for desktop (Windows/macOS/Linux) and mobile (Android), running the same shared engine locally | `qofeno serve` + shells in `apps/` |

GitHub automation in this repository is **internal infrastructure** (webhook-verified repository protection under `integrations/`) — not a product.

> The CLI never requires a browser or GUI; the App never requires a terminal.

## Principles (enforced in code, not just words)

- **Permissions are enforced in code.** Every tool call passes schema validation → permission rules → policy engine → timeout → output caps. Model text can never override a security boundary.
- **Local models are first-class.** Ollama works out of the box; hosted providers (OpenAI-compatible, Anthropic) are optional adapters.
- **No silent anything.** No silent provider switching for protected data, no silent file destruction, no fabricated results, no fake progress.
- **Zero runtime dependencies** across all packages — the supply chain is our own audited TypeScript plus Node's standard library.
- **Docker is never required** — CLI, App and local models run natively; containers remain optional CI/self-hosting tooling.
- **Fail closed, fail safely.** Non-interactive mode denies unconfigured risky operations; errors preserve user data and say what happened.

## Quick start

```bash
npm install -g @agent-qofeno/qofeno-cli     # or: npm i && npm run build from source
qofeno doctor                        # environment diagnostics
qofeno provider add ollama           # local models first
ollama pull llama3.2                 # you choose what to download — never us
qofeno                               # interactive session
```

First useful things to try:

```
› /help                       command reference
› /mode plan                  read-only exploration mode
› explain how error handling flows through this repo
› /knowledge index README.md  make docs searchable
› qofeno -p "summarize package.json" --output-format json
```

## Headless & CI

```bash
qofeno -p "what changed in src?"            # print mode
qofeno -p "..." --output-format jsonl       # machine-readable streaming lines
CI=1 qofeno agents run "run tests" --model ollama:llama3.2   # fails closed without explicit rules
```

Exit code contract: `0` ok · `2` bad input · `3` permission/policy · `4` not found · `20` provider · `21` auth · `22` storage · `23` rate-limited · `124` timeout · `130` cancelled.

## Security model in one paragraph

Tool calls flow through one gate (`ToolRegistry.invoke`): declared JSON-schema validation, persisted allow/deny permission rules with pattern/project scopes, an independent policy engine (deny > confirm > allow), risk-tiered consent prompts, per-tool timeouts, and output caps. Shell commands are risk-classified by full-line analysis (pipes, redirects, substitution — not naive prefix matching). Web fetches pass SSRF guards (private ranges blocked). Terminal output from any untrusted source is ANSI/OSC-sanitized. Secrets live in your OS credential store (Keychain/libsecret/Credential Manager) or an AES-256-GCM vault — never in logs, context or output. See [docs/security.md](docs/security.md).

## Repository layout

```
packages/
  core/         domain contracts: errors, schemas, events, policy, provider & storage interfaces
  security/     secret stores, path guards, SSRF defense, sanitization, redaction, rate limiting
  storage/      SQLite (node:sqlite) adapter: migrations, FTS5 search, blob store
  providers/    OpenAI-compatible / Ollama / Anthropic adapters + routing with privacy rules
  runtime/      platform paths, process supervisor, capability detection
  term/         themes, width-aware layout, diff renderer, markdown renderer
  input/        line editor: history, completion, multiline, bracketed paste, undo
  config/       layered configuration (org < user < project < profile), workspace trust
  session/      session engine: resume, branch, compact, export/import
  knowledge/    memory + knowledge engines, hybrid retrieval with provenance
  ctx/          token-budgeted context assembly with compaction
  tools/        tool runtime + built-ins (fs, shell, git, tests, web, calc)
  agents/       bounded agent loop + multi-agent task queue
  workflows/    versioned workflow definitions + timezone-aware scheduling
  ext/          extensions, skills, hooks, MCP stdio client compatibility
  repl/         interactive core: modes, slash commands, permission UX
  cli/          the qofeno executable + headless modes
  server/       local HTTP API that powers both products
apps/
  app/          the Qofeno App UI (shared by desktop & mobile shells)
  desktop/      Tauri v2 shell (Win/macOS/Linux installers)
  mobile-android/  signed APK/AAB pipeline
```

Compatibility claims are evidence-gated: see [docs/compatibility.md](docs/compatibility.md) and [docs/COMMAND_PARITY.md](docs/COMMAND_PARITY.md).

## Building from source

```bash
git clone https://github.com/SohailKhan0525/qofeno
cd qofeno && npm install
npm run build        # tsc project references
npm test             # node:test suites incl. adversarial security tests
npm run lint
```

Requires Node ≥ 20.12 (built-in SQLite). Works on Linux, macOS, Windows/WSL, BSDs, containers and SSH/tmux sessions; capability detection degrades gracefully (NO_COLOR, dumb terminals, narrow widths).

## Documentation

- [OpenCode Command Parity Matrix](docs/COMMAND_PARITY.md) · [CLI reference](docs/cli-reference.md)
- [Architecture](docs/architecture.md) · [Security model](docs/security.md) · [Privacy model](docs/privacy.md)
- [Providers & models](docs/providers.md) · [Release & Publishing](docs/release.md)
- [Self-hosting the App](docs/self-hosting.md) · [Threat model summary](docs/security.md#threat-model)
- [Governance](GOVERNANCE.md) · [Contributing](CONTRIBUTING.md)

## Status

Qofeno follows honest-release practices: features described here are implemented and tested in-repo (110+ tests including adversarial security suites). Roadmap items and known gaps are tracked in [CHANGELOG.md](CHANGELOG.md) rather than hidden.

## License

Apache-2.0 — see [LICENSE](LICENSE).
