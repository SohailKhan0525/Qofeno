# Qofeno Desktop

Tauri v2 shell around the shared App UI (`apps/app/dist`), with an engine sidecar.

## Build locally

```bash
npm run -w @agent-qofeno/app build          # UI bundle
cd apps/desktop/src-tauri
cargo tauri build                            # produces deb/rpm/AppImage/dmg/msi/nsis
```

## Release evidence requirements (per open2.md compatibility rule)

A desktop platform is claimed as *supported* only when CI has produced, on real runners:

| Platform | Installer | Launch test | Update test |
|---|---|---|---|
| Linux x64/ARM64 | deb, rpm, AppImage | smoke via xvfb | updater manifest check |
| Windows x64 | nsis/msi | smoke launch | updater manifest check |
| macOS arm64 | dmg (signed+notarized when certs present) | smoke launch | updater manifest check |

Signing keys are provided as protected-environment secrets only; unsigned artifacts are labeled `-unsigned`.
