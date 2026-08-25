# Release Process

1. Update CHANGELOG.md (Keep a Changelog format).
2. Tag `vX.Y.Z` on main after green CI.
3. The release workflow: builds, runs full tests, generates SBOM + source tarball + SHA256SUMS, creates the GitHub Release, publishes changed `@agent-qofeno/*` packages with provenance.
4. Post-release checklist: docs match behavior; migration notes present if storage/config changed.

Versioning: SemVer. Breaking changes only in major versions, documented in CHANGELOG with migration paths.
