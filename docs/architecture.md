# Architecture

Qofeno is a strict-layered TypeScript monorepo with zero runtime dependencies. Dependencies point downward only; the domain layer knows no vendor.

```
┌────────────────────────────────────────────────────────────┐
│ products: cli · repl · server(App) · github-bot(Bot)       │
├────────────────────────────────────────────────────────────┤
│ application engines: session · memory/knowledge · ctx      │
│ agents · workflows · ext(plugins/MCP)                      │
├────────────────────────────────────────────────────────────┤
│ platform services: tools(gate) · providers(routing)        │
│ config(layers/trust) · runtime(process/capabilities)       │
├────────────────────────────────────────────────────────────┤
│ foundation: core(contracts) · security(crypto/guards)      │
│ storage(sqlite/FTS5/blobs) · term(render) · input(editor)  │
└────────────────────────────────────────────────────────────┘
```

## Trust boundaries

1. **Human ↔ CLI** — keyboard input; the only source of *authorization intent*.
2. **Model ↔ host** — model text is untrusted data. Tool calls are requests, not authority. The single enforcement point is `ToolRegistry.invoke`.
3. **Local ↔ network** — provider adapters and `web_fetch` cross this line through SSRF guards + classification policy (`local-only`/`sensitive` never reach external hosts without explicit policy change).
4. **Repo ↔ machine** — project files/config are untrusted; `.qofeno.json` can tighten but never weaken security keys.

## Request lifecycle (interactive turn)

```
input editor ─▶ slash?──▶ command router ──▶ engine call ─▶ storage/events
     │ no
     ▼
session.append(user msg)
     ▼
ContextManager.assemble(budget)   ← memories(knowledge retrieval) ← FTS5/embeddings
     ▼
ProviderRegistry.route(classification, capability, preference)
     ▼
provider.chat() ──stream──▶ renderer(sanitized)
     ▼ tool_calls?
ToolRegistry.invoke per call (schema→permissions→policy→confirm→timeout)
     ▼
persist assistant/tool messages (branch-aware tree)
```

## Storage

Single SQLite database (`~/.qofeno/qofeno.db`, WAL) via node:sqlite: versioned migrations, FTS5 mirrors for messages/chunks, content-addressed blobs under `blobs/`. All access goes through the `Storage` interface — swapping engines means implementing that interface, nothing else.

## Why these choices

- **node:sqlite over native deps** — portability (Termux/BSD/CI), supply-chain surface of zero.
- **Interfaces in core, implementations outside** — any provider/database/renderer is replaceable; the spec's no-lock-in requirement is structural, not aspirational.
- **One gate for privileged ops** — auditable, testable, impossible to bypass from prompt text.
- **Token-budgeted context with explicit dropping order** — long sessions degrade predictably; system instructions are never silently discarded.
