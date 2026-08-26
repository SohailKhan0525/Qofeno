# Compatibility Matrix

Qofeno claims support only where build, install, launch and security-test evidence exists (open2.md law). Status as of v0.1.0:

| Surface | Target | Build evidence | Install/launch | Tests | Status |
|---|---|---|---|---|---|
| CLI | Linux x64/arm64 (glibc, musl) | CI matrix | npm global / source | full suite incl. security | **supported** |
| CLI | macOS arm64/x64 | CI matrix | npm global / source | full suite | **supported** |
| CLI | Windows x64 (PowerShell/cmd) | CI matrix | npm global | full suite (shell adapter) | **supported** |
| CLI | WSL, SSH, tmux/screen, containers, dumb TTYs | capability-detection suite | — | degradation tests | **supported** |
| App (web console) | any modern browser via `qofeno serve` | built + served | verified | API integration tests | **supported** |
| Desktop | Linux deb/rpm/AppImage (x64/arm64) | Tauri pipeline configured | pending runner evidence | UI unit + API tests | **packaging-ready** |
| Desktop | Windows nsis/msi | Tauri pipeline configured | pending | — | **packaging-ready** |
| Desktop | macOS dmg (sign/notarize) | pipeline w/ cert gate | pending | — | **packaging-ready** |
| Android APK/AAB | minSdk 24, target 35 | gradle signing pipeline documented | pending keystore env | — | **pipeline-ready** |
| iOS/iPadOS | xcodeproj via Tauri mobile | config present | no toolchain evidence yet | — | **experimental** |

Legend: *supported* = evidence complete · *packaging/pipeline-ready* = real configs+workflows merged, artifacts require the corresponding runners/secrets · *experimental* = do not rely on it.

This file is updated with each release; unsupported platforms are never claimed.
