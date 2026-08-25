# Changelog

All notable changes are documented here. Format based on Keep a Changelog; versioning follows SemVer.

## [0.1.0] — 2026-08-25

Initial public release of the unified Qofeno repository (CLI + App + GitHub Bot).

### Added — CLI
- Interactive terminal agent: streaming responses, slash commands (`/help`, `/model`, `/mode`, `/memory`, `/knowledge`, `/compact`, `/sessions`, `/export`, `/privacy`, …), plan/review/execute/autonomous/restricted modes.
- Permission engine enforced in code: persisted grants & denies with session/project/pattern scopes; risk-tiered consent prompts; deny-and-remember rules.
- Independent policy engine with deterministic precedence (deny > confirm > allow).
- Built-in tools: `fs_read`, `fs_write` (atomic), `fs_edit` (unambiguous replace), `fs_list`, `fs_grep`, `shell_exec` (risk-classified), `git_status/diff/commit`, `tests_run` (npm/pnpm/yarn/pytest detection), `web_fetch` (SSRF-guarded), `calc` (no-eval arithmetic).
- Provider abstraction with OpenAI-compatible, Ollama and Anthropic adapters; capability discovery; privacy-aware routing that refuses silent provider switching for sensitive data.
- Local AI first-class: Ollama model discovery, health checks, resource hints; never downloads models without user action.
- Session engine: create/resume/rename/archive/export/import (validated), branching on message edit, compaction with honest summaries.
- Memory engine: scoped (global/project/session) explicit memories with provenance, TTL, search, deletion.
- Knowledge engine: collections, sha256-deduplicated sources, paragraph chunking, FTS5 keyword + optional semantic embeddings, reciprocal-rank-fusion hybrid retrieval with citations.
- Context manager: token budgets, priority assembly, deterministic dropping order (system instructions never silently dropped).
- Agent runtime: bounded plan→act→observe loop with max-steps/timeout/budget guards and activity summaries; multi-agent task queue with bounded concurrency.
- Workflow engine: schema-validated definitions, tool steps through the same security gate, approvals, loop detection, timezone-aware cron scheduling subset.
- Extensions: validated manifests, untrusted-by-default lifecycle, MCP stdio client compatibility (initialize/tools list/call) re-gated through host permissions.
- Terminal layer: themes incl. NO_COLOR/high-contrast/monochrome, CJK-width-aware wrapping/truncation, diff renderer, markdown renderer, ANSI-sanitized untrusted output.
- Line editor: history + reverse search, completion hooks, multiline, bracketed paste, undo/redo, word ops.
- Configuration: layered org/user/project/profile/session precedence where security keys can only be tightened downward; workspace trust store; env-var overrides limited to non-security keys.
- Headless modes: print mode, text/json/jsonl outputs, CI fail-closed defaults, documented exit-code contract.

### Added — App (server)
- Zero-dependency HTTP API over the same engines: sessions, messages, chat (policy-routed), memory CRUD, secured tool invocation, audit events, health endpoint.
- Security headers, bearer-token auth option, rate limiting, JSON body caps, SPA static serving with traversal protection.
- Accessible web console (skip links, aria-live log, keyboard-first composer).

### Added — GitHub Bot
- Webhook service with constant-time HMAC-SHA256 verification, RS256 App JWTs, installation token exchange.
- Minimum-permission design; `/qofeno help|summarize|checklist` automation for issues and PRs; redacted deterministic comments.

### Infrastructure
- TypeScript strict monorepo with project references; node:test suites (110+ tests) including adversarial security coverage (terminal escape injection, path traversal/symlink escape, SSRF targets, shell risk classification, secret scanning/redaction, vault integrity, webhook forgery).
- GitHub Actions CI matrix, release pipeline with SHA-256 checksums and SBOM; Docker image (non-root); npm publication under the `@agent-qofeno` scope.
