# Governance

## Roles

- **Maintainers** (listed below) merge PRs, cut releases, and own security response for their areas.
- **Contributors** submit PRs/issues following [CONTRIBUTING.md](CONTRIBUTING.md).
- **The lead** (@SohailKhan0525) breaks ties and may veto releases; this role exists so the project never stalls on disagreement.

Current maintainers:

| Area | Maintainer |
|---|---|
| core/security/storage | @SohailKhan0525 |
| providers/agents/workflows | @SohailKhan0525 |
| term/input/repl/cli UX | @SohailKhan0525 |
| server/app + github-bot | @SohailKhan0525 |

(The table is intentionally small at 0.1; it grows by invitation after sustained, high-quality contribution. No single-person knowledge silos: every area requires docs + tests sufficient for handover.)

## Decision making

- Routine changes: normal PR review.
- Substantive architecture: an ADR under `docs/decisions/` (context → decision → consequences).
- Security-relevant changes require a maintainer review plus negative tests.
- Releases follow [docs/release.md](release.md); a release is blocked if required checks fail or documentation diverges from behavior.

## Values

User ownership of data and compute outranks convenience. Honest status reporting outranks impressive demos. Accessibility and privacy are release criteria, not backlog items.
