# Release Process & Publishing Gates

Qofeno follows automated, evidence-gated release practices. Releases are published through GitHub Actions with strict version checking, SBOM generation, package provenance, and multi-platform binary compilation.

## Release Pipeline Overview

```text
VERIFY CI → VERSION GATE (npm query) → AUTO-BUMP IF NEEDED → BUILD → TEST → SBOM → PUBLISH NPM → COMPILE DESKTOP & ANDROID → ASSEMBLE GITHUB RELEASE
```

## Release Steps

1. **Verification Gate**:
   - Monorepo full build (`tsc -b tsconfig.all.json`).
   - 100% unit and integration test pass (`npm test`).
   - Linting and supply-chain zero-foreign-dependency checks (`npm run lint`).

2. **Version Detection Gate**:
   - `scripts/check-and-bump-version.mjs` inspects the public npm registry for `@agent-qofeno/*` and `qofeno`.
   - If the version already exists on npm, it automatically computes the next SemVer patch bump and updates all monorepo manifests and internal references.
   - Prevents immutable package publishing collisions.

3. **npm Publishing with Provenance**:
   - Runs in the protected `npm-release` environment with `NPM_TOKEN`.
   - Publishes packages in topological dependency order via `scripts/publish-all.mjs`.
   - Post-publish verification polls the registry index to ensure the packages are live.

4. **Multi-Platform Desktop Bundles**:
   - Matrix builds across Ubuntu, Windows, and macOS.
   - Produces Linux `.deb`, `.AppImage`, Windows `.msi`, `.exe`, macOS `.dmg`.

5. **Android Release**:
   - Assembles release `.apk` and `.aab` packages with signing verification via `apksigner`.

6. **GitHub Release**:
   - Collects all OS installers, Android APK, source tarballs, `sbom.json`, and `command-parity.json`.
   - Computes `SHA256SUMS.txt` cryptographic hashes.
   - Creates GitHub Release with auto-generated release notes.
