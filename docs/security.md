# Security Model

This document describes what Qofeno actually enforces. Claims here map to tested code (see `packages/*/test/`, especially adversarial suites).

## What is encrypted, where keys live

| Data | At rest | Where |
|---|---|---|
| Sessions/messages/memory/knowledge | SQLite file under `~/.qofeno/` (OS-level protection applies) | local disk |
| API keys | OS credential store (Keychain / libsecret / Credential Manager) or AES-256-GCM vault | `~/.qofeno/credentials/secrets.bin` |
| Vault key | scrypt-derived from `QOFENO_MASTER_KEY` env or a 0600 machine keyfile | never logged, never in context |

If the master key is lost the vault cannot be decrypted — by design. Re-run `qofeno provider add` to re-enter keys.

## Enforcement pipeline

Every tool invocation (`ToolRegistry.invoke`) executes, in order:

1. **Schema validation** of arguments against the tool's declared schema.
2. **Permission rules** — persisted grants/denies with scopes: `always`, `session`, `project:<root>`, `pattern:<prefix|host>`. Denies win regardless of order. Non-interactive sessions require pre-existing rules: no prompts, fail closed.
3. **Policy engine** — independent rules engine; effect precedence deny > confirm > allow, then specificity. Defaults when nothing matches: low-risk tools allowed; risky tools require consent interactively and are denied headlessly.
4. **Confirmation UX** — destructive/opaque shell commands always ask, showing operation, target, risk class and reasons.
5. **Execution bounds** — per-tool timeout, 512KB child output cap, 20K-char tool-result cap into context.
6. **Audit record** — action, target, decision; metadata only, no content.

## Shell safety

`analyzeCommand` performs structural analysis of the full line: pipes, redirects, chaining, substitution (`$(`), eval/sh -c wrappers mark commands *unanalyzable* which forces approval. Destructive classes (rm -rf, git reset --hard/clean -f/push --force, mkfs, dd, drop table…) are blocked behind explicit confirmation even for granted subjects.

## SSRF defense

`web_fetch`: http/https only; localhost/metadata/link-local/private v4+6 ranges (incl. CGNAT) resolved via DNS and refused; allowlist override is explicit configuration; redirects are followed client-side by fetch with re-validation on each hop's final URL policy checks applied at request time.

## Terminal hygiene

All untrusted strings (model output, file contents, web text) pass `sanitizeForTerminal`: CSI/OSC/DCS sequences stripped, C0/C1 removed except \n\t, bidi-override and zero-width characters dropped (#RTL/bidi safety). NO_COLOR, TERM=dumb, narrow widths and CI environments degrade rendering without losing information.

## Threat model (living summary)

| Asset | Threat | Mitigation |
|---|---|---|
| User files | model-initiated destruction | fs tools project-rooted, atomic writes, unambiguous-edit rule, confirmation + deny rules |
| Credentials | exfiltration via logs/context/output | secret store isolation, redaction at log/error boundaries, secret scanning before export/sync |
| Local network | SSRF pivoting | scheme/IP/DNS guards |
| Terminal session | escape injection | output sanitization layer |
| Policy integrity | prompt-injected "instructions" | policies live outside any prompt; model text is data |
| Supply chain | malicious deps | zero runtime dependencies, locked dev deps, audit in CI |

Residual risks (documented honestly): a user who approves everything can still be socially engineered — approvals show full command lines to make that visible; OS-level compromise defeats all local controls.

## Security regression testing

Vulnerability fixes ship with negative tests named `security:` … e.g. terminal escape suite, symlink escape test, webhook forgery test.
