# Qofeno Mobile (Android first)

Tauri v2 mobile target for the shared App UI. Android ships as a real signed APK (installable) and AAB (store publishing). iOS configuration is included but marked **experimental** until CI evidence exists on macOS runners with signing credentials.

## Layout

```
apps/mobile-android/
  README.md                  ← you are here
  signing/                   ← NOT committed. Local keystore + env template.
  tauri.android.conf.json    ← mobile-specific overrides
```

## Build a signed APK locally

```bash
npm run -w @agent-qofeno/app build
cd apps/app && npx @tauri-apps/cli android init --ci || true   # generates gen/android once
cd gen/android
./gradlew assembleRelease bundleRelease \
  -PqofenoKeystoreFile=$QOFENO_KEYSTORE_PATH \
  -PqofenoKeystorePassword=$QOFENO_KEYSTORE_PASSWORD \
  -PqofenoKeyAlias=$QOFENO_KEY_ALIAS \
  -PqofenoKeyPassword=$QOFENO_KEY_PASSWORD
# verify the signature (release pipeline does this too)
$ANDROID_HOME/build-tools/*/apksigner verify --verbose app-release/outputs/apk/release/app-release.apk
```

## Rules enforced by the release pipeline

1. Signing keys never live in the repository; CI reads them from a protected GitHub Environment (`mobile-release`).
2. Fork PRs can build **unsigned** artifacts only.
3. Every release artifact gets SHA-256 checksums; APKs get `apksigner verify` output attached as provenance evidence.
4. The compatibility matrix in `docs/compatibility.md` is updated only when build+install+launch evidence exists.

## Minimum Android permissions

`INTERNET` only, plus optional `POST_NOTIFICATIONS` behind an explicit user opt-in. No location, contacts, or storage broad access: file interactions go through the system document picker (SAF).
