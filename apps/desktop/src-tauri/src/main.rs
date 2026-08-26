//! Qofeno desktop shell.
//!
//! Architecture note (documented reason for the system-webview approach):
//! the App UI is a single portable build rendered inside the OS webview via
//! Tauri v2. This is not a hosted website: all assets ship inside the signed
//! binary, run fully offline against a bundled/sidecar `qofeno serve`
//! process, and platform integrations (notifications, secure storage,
//! filesystem) go through Tauri capabilities below. This is the same
//! architecture class used by VS Code / 1Password; it avoids shipping an
//! entire Chromium (Electron) while remaining one codebase across
//! Windows/macOS/Linux plus Android/iOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|_app| {
            // The engine sidecar (`qofeno serve --port 7931`) is spawned here in
            // release builds via tauri.conf bundle.externalBin; dev mode expects
            // `cargo qofeno-dev` style manual start. See apps/desktop/README.md.
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running qofeno desktop");
}
