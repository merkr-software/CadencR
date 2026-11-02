//! Watches the settings directory and broadcasts a change event when a settings
//! file is created/modified — by our own writes or an external editor/script.
//! The broadcast drives the frontend to re-fetch so external edits show up live.

use std::path::Path;
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use tokio::sync::broadcast;

use crate::shared::file_watch::watch_dir;

use super::{paths, SettingsChangeEvent};

/// Settings edits are not a live-preview surface, so a longer window than the
/// themes watcher uses is fine — it collapses the burst one save fans out into.
const DEBOUNCE: Duration = Duration::from_millis(500);

/// Start watching `dir` (non-recursive). Best-effort: a failure is logged but
/// never fatal — settings still work, just without live external-edit refresh.
pub fn start(dir: &Path, tx: broadcast::Sender<SettingsChangeEvent>) {
    watch_dir(dir, RecursiveMode::NonRecursive, DEBOUNCE, tx, |path| {
        settings_file_name(path).map(|file| {
            if file == paths::GLOBAL_FILE_NAME {
                super::generation::bump_global();
                crate::domain::telemetry::settings_changed();
            }
            SettingsChangeEvent { file }
        })
    });
}

/// Returns the file name if `path` is a settings document we care about
/// (`settings.json` or `*.settings.json`), filtering out the dotfile temp files
/// our atomic writes create.
fn settings_file_name(path: &Path) -> Option<String> {
    let name = path.file_name()?.to_str()?;
    if name.starts_with('.') {
        return None;
    }
    if name == paths::GLOBAL_FILE_NAME || name.ends_with(".settings.json") {
        Some(name.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn recognizes_settings_files() {
        assert_eq!(
            settings_file_name(&PathBuf::from("/s/settings.json")),
            Some("settings.json".to_string())
        );
        assert_eq!(
            settings_file_name(&PathBuf::from("/s/my-project.settings.json")),
            Some("my-project.settings.json".to_string())
        );
    }

    #[test]
    fn ignores_temp_and_unrelated_files() {
        assert!(settings_file_name(&PathBuf::from("/s/.settings.json.tmp")).is_none());
        assert!(settings_file_name(&PathBuf::from("/s/notes.txt")).is_none());
        assert!(settings_file_name(&PathBuf::from("/s/cadencr.db")).is_none());
    }
}
