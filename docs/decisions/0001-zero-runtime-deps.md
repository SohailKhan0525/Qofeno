# ADR 0001: Zero runtime dependencies

Status: accepted

Context: Qofeno is a security-sensitive terminal tool run in heterogeneous environments (Termux, BSD, CI, WSL).

Decision: all packages under packages/* have internal-only runtime dependencies; Node stdlib provides SQLite, HTTP, crypto, test runner.

Consequences: larger first-party code; dramatically smaller supply-chain surface and portable installs. Dev-only tooling (eslint/prettier/typescript) stays at the root.
