# Security Policy

## Reporting a vulnerability

Email **security@qofeno.dev** (monitored; PGP key published at https://qofeno.dev/security.asc) or open a private GitHub security advisory on this repository. Please do not disclose publicly until a fix ships.

Include: affected component/package, reproduction steps or PoC, impact assessment. We aim to acknowledge within 48h and publish advisories with credit after a patch release.

Severity classification follows CVSS v3.1; critical issues receive emergency releases.

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Security architecture summary

- **Enforcement points**: every privileged operation passes `ToolRegistry.invoke` (schema validation → permission rules → policy engine → confirmation gates → timeout → output caps). Model output is treated as untrusted input at all times.
- **Credential storage**: OS credential store when available; otherwise AES-256-GCM vault keyed by scrypt from `QOFENO_MASTER_KEY` or a 0600 machine keyfile.
- **Shell safety**: commands are risk-classified by full-line structural analysis; destructive/opaque constructs require explicit consent even when broadly granted.
- **SSRF defense**: scheme allowlist, private/link-local/metastack IP blocking with DNS resolution checks, per-host rate limits.
- **Terminal hygiene**: untrusted content is stripped of ANSI/OSC/C1 control sequences before rendering; NO_COLOR/dumb terminals supported.
- **Supply chain**: zero runtime dependencies; CI runs audit + license checks; releases ship SHA-256 checksums and an SBOM.

Full details: [docs/security.md](docs/security.md). Threat model with trust boundaries is maintained there and updated with each capability change.

## Security regression policy

Every fixed vulnerability gets a regression test in the same PR where practical, tagged `security:` in the test title.
