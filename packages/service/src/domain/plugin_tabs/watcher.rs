//! Watches `~/.cadencr/plugins/tabs` and broadcasts when a tab changes.
//!
//! "Every change to `tab.json` or the build output reloads live instances": the
//! author's `vite build --watch` rewrites `dist/` (or whichever folder holds the
//! manifest's `entry`), and clients subscribed through
//! `app/subscribe.plugin_tab_events` receive `app/plugin_tab_changed
//! {plugin_id}` and refetch or reload. `node_modules`, sources and dot-files
//! are ignored — they are not what Cadencr loads.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify_debouncer_mini::notify::RecursiveMode;
use tokio::sync::broadcast;
use tracing::warn;

use cadencr_plugin_core::tab::MANIFEST_FILE_NAME;

use crate::shared::file_watch::watch_dir_coalesced;

/// Collapses a build's burst of writes into one event per batch.
const DEBOUNCE: Duration = Duration::from_millis(250);

/// Tab `plugin_id` changed on disk: its manifest, icon or build output.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PluginTabChangedEvent {
    pub plugin_id: String,
}

/// Start watching `dir` (created first: `notify` cannot watch a missing path,
/// and the first tab would otherwise never reload live). A rebuild touches
/// many files of one tab; each debounced batch yields one event per tab.
pub fn start(dir: &Path, tx: broadcast::Sender<PluginTabChangedEvent>) {
    // A revocation is a change of the managed tabs it names, too.
    super::managed::policy::spawn_refresh_task(tx.clone());
    if let Err(error) = crate::remote::secure_fs::create_dir_owner_only(dir) {
        warn!(dir = %dir.display(), "failed to create the custom tabs dir: {error}");
        return;
    }
    let roots = roots_of(dir);
    let folders = Mutex::new(tab_folders(dir));
    watch_dir_coalesced(dir, RecursiveMode::Recursive, DEBOUNCE, tx, move |path| {
        let plugin_id =
            changed_plugin_id(&roots, path).or_else(|| moved_plugin_id(&roots, &folders, path))?;
        Some(PluginTabChangedEvent { plugin_id })
    });
}

/// The tab folders present now: what a folder event is compared against.
fn tab_folders(dir: &Path) -> HashSet<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return HashSet::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect()
}

/// The tab id when `path` is a tab folder `<root>/<id>` that appeared or went
/// away (moved in, renamed, removed): neither side's files may report a
/// change of their own. A folder event for a tab that is still where it was
/// (its own metadata changing) is not a change of the tab.
fn moved_plugin_id(
    roots: &[PathBuf],
    folders: &Mutex<HashSet<String>>,
    path: &Path,
) -> Option<String> {
    let relative = roots.iter().find_map(|root| path.strip_prefix(root).ok())?;
    let mut components = relative.components();
    let (Some(Component::Normal(id)), None) = (components.next(), components.next()) else {
        return None;
    };
    let id = id.to_str().filter(|id| !id.starts_with('.'))?;
    let present = path.is_dir();
    let mut folders = folders
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let known = folders.contains(id);
    if present == known {
        return None;
    }
    if present {
        folders.insert(id.to_string());
    } else {
        folders.remove(id);
    }
    Some(id.to_string())
}

/// The watched root as given and canonicalized: macOS reports `/private/var/…`
/// for a `/var/…` watch.
fn roots_of(dir: &Path) -> Vec<PathBuf> {
    let mut roots = vec![dir.to_path_buf()];
    if let Ok(canonical) = dir.canonicalize() {
        if canonical != dir {
            roots.push(canonical);
        }
    }
    roots
}

/// The tab id when `path` is `<root>/<id>/tab.json`, anything under
/// `<root>/<id>/dist/` or the folder holding the manifest's `entry`, or an
/// `.svg` (any case, any depth) — never inside a dot-folder or `node_modules`.
/// Walks the components lazily: a dependency install reports thousands of
/// paths, and most are refused at the second one.
fn changed_plugin_id(roots: &[PathBuf], path: &Path) -> Option<String> {
    let (root, relative) = roots
        .iter()
        .find_map(|root| Some((root, path.strip_prefix(root).ok()?)))?;
    let mut segments = relative.components().map(|component| match component {
        Component::Normal(segment) => segment.to_str(),
        _ => None,
    });
    let id = segments.next()??;
    if id.starts_with('.') {
        return None;
    }
    let mut rest = Vec::new();
    for segment in segments {
        let segment = segment?;
        if segment.starts_with('.') || segment == "node_modules" {
            return None;
        }
        rest.push(segment);
    }
    let relevant = rest.first() == Some(&"dist")
        || rest == [MANIFEST_FILE_NAME]
        || rest
            .last()
            .is_some_and(|name| name.to_ascii_lowercase().ends_with(".svg"))
        || in_web_root(&root.join(id), &rest);
    relevant.then(|| id.to_string())
}

/// Whether `rest` (inside the tab folder `tab_dir`) is the folder holding the
/// manifest's `entry` — what `assets` serves — or under it. A manifest that
/// can't be read names no folder: its own change is reported above.
fn in_web_root(tab_dir: &Path, rest: &[&str]) -> bool {
    if rest.is_empty() {
        return false;
    }
    let Ok(text) = std::fs::read_to_string(tab_dir.join(MANIFEST_FILE_NAME)) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(entry) = manifest.get("entry").and_then(serde_json::Value::as_str) else {
        return false;
    };
    match entry.rsplit_once('/') {
        Some((web_root, _)) => rest.starts_with(&web_root.split('/').collect::<Vec<_>>()),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(path: &str) -> Option<String> {
        changed_plugin_id(&[PathBuf::from("/t/tabs")], Path::new(path))
    }

    #[test]
    fn recognizes_manifest_icon_and_build_output() {
        assert_eq!(id("/t/tabs/graph/tab.json").as_deref(), Some("graph"));
        assert_eq!(id("/t/tabs/graph/icon.svg").as_deref(), Some("graph"));
        assert_eq!(
            id("/t/tabs/graph/assets/Icon.SVG").as_deref(),
            Some("graph")
        );
        assert_eq!(id("/t/tabs/graph/dist").as_deref(), Some("graph"));
        assert_eq!(
            id("/t/tabs/graph/dist/assets/app.js").as_deref(),
            Some("graph")
        );
    }

    #[test]
    fn ignores_sources_dependencies_and_dot_files() {
        for path in [
            "/t/tabs",
            "/t/tabs/graph",
            "/t/tabs/graph/src/App.tsx",
            "/t/tabs/graph/node_modules/react/index.js",
            "/t/tabs/graph/.git/index",
            "/t/tabs/graph/.tab.json.tmp",
            "/t/tabs/graph/dist/.vite/manifest.json",
            "/t/tabs/graph/src/tab.json",
            "/t/tabs/graph/node_modules/pkg/logo.svg",
            "/t/tabs/.trash/tab.json",
            "/elsewhere/graph/tab.json",
        ] {
            assert_eq!(id(path), None, "{path}");
        }
    }

    #[test]
    fn reports_a_tab_folder_that_appears_or_goes_away() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("graph")).unwrap();
        let roots = [root.path().to_path_buf()];
        let folders = Mutex::new(tab_folders(root.path()));
        let moved = |name: &str| moved_plugin_id(&roots, &folders, &root.path().join(name));
        // Still where it was: its own metadata changing is not a tab change.
        assert_eq!(moved("graph"), None);
        // Renamed: the new folder appears, the old one goes away.
        std::fs::rename(root.path().join("graph"), root.path().join("chart")).unwrap();
        assert_eq!(moved("chart").as_deref(), Some("chart"));
        assert_eq!(moved("graph").as_deref(), Some("graph"));
        assert_eq!(moved("graph"), None);
        // Deeper paths and dot-folders are not folder moves.
        std::fs::create_dir_all(root.path().join(".trash")).unwrap();
        assert_eq!(moved(".trash"), None);
        assert_eq!(moved("chart/src"), None);
    }

    #[test]
    fn follows_an_entry_outside_dist() {
        let root = tempfile::tempdir().unwrap();
        let tab = root.path().join("site");
        std::fs::create_dir_all(&tab).unwrap();
        std::fs::write(tab.join("tab.json"), r#"{ "entry": "public/index.html" }"#).unwrap();
        let roots = [root.path().to_path_buf()];
        let id = |relative: &str| changed_plugin_id(&roots, &tab.join(relative));
        assert_eq!(id("public/index.html").as_deref(), Some("site"));
        assert_eq!(id("public/assets/app.js").as_deref(), Some("site"));
        assert_eq!(id("public").as_deref(), Some("site"));
        assert_eq!(id("src/main.ts"), None);
        assert_eq!(id("publicity/x.js"), None);
    }

    #[test]
    fn matches_either_spelling_of_the_root() {
        let roots = [PathBuf::from("/var/t"), PathBuf::from("/private/var/t")];
        assert_eq!(
            changed_plugin_id(&roots, Path::new("/private/var/t/g/tab.json")).as_deref(),
            Some("g")
        );
    }
}
