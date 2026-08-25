# Contributing to Qofeno

Thanks for helping build a user-owned AI platform. Every kind of contribution is welcome: code, docs, translations, accessibility reviews, security research, design, testing.

## Ground rules

1. **No fake functionality.** Features must do what they claim; tests must test real behavior. Adversarial security behavior needs negative tests.
2. **Security boundaries live in code.** New tools must declare schemas, permissions and risk; they execute only through `ToolRegistry.invoke`.
3. **Zero runtime dependencies** in `packages/*`. Use Node's standard library. Dev deps are fine at the root.
4. **Every user-visible failure must explain:** what happened, whether data was affected, how to recover. Never expose secrets.
5. **TypeScript strict mode; no TODOs in critical paths.**

## Workflow

```bash
npm install
npm run build && npm test      # green before you start
# ...make changes with tests...
npm run lint && npm test       # green before the PR
```

PR checklist:

- [ ] Tests cover new behavior (including failure paths)
- [ ] Docs updated (`docs/`, CLI help text) when behavior changed
- [ ] Security review note if touching: permissions, policy, secrets, shell, fs, network
- [ ] Migration notes if storage/config schema changed

## Reporting vulnerabilities

See [SECURITY.md](SECURITY.md). Please use private disclosure — do not open public issues for security problems.

## Areas that especially need help

- Accessibility audits of the terminal UX (screen readers, high contrast)
- Translations & RTL/bidi verification
- Windows-specific path/process edge cases
- Additional local inference adapters (llama.cpp server, vLLM, LM Studio are OpenAI-compatible already)
