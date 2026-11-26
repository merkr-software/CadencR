//! Codex state that follows a moved project folder.
//!
//! Codex keeps its sessions globally and `thread/resume` takes the new cwd,
//! so conversations follow by themselves. What it files under the folder's
//! path is the per-folder table of `config.toml`, `[projects."<path>"]`,
//! which holds the folder's trust level: left behind, Codex treats the moved
//! folder as untrusted. Those entries are renamed in every `config.toml` a
//! profile uses, editing the document in place so the user's comments and
//! layout survive.

use std::collections::BTreeSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use toml_edit::{DocumentMut, TableLike};

use super::profiles;
use crate::domain::agents::relocation::{FolderMove, ProviderRelocator};
use crate::shared::atomic_file::write_atomic_in_place;
use crate::shared::path_rebase::rebase_str;

#[derive(Debug)]
pub(crate) struct CodexRelocator;

#[async_trait]
impl ProviderRelocator for CodexRelocator {
    async fn relocate(&self, moved: FolderMove<'_>) -> Result<Vec<String>, String> {
        let (from, to) = (moved.from.to_path_buf(), moved.to.to_path_buf());
        let files = config_files().map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || relocate_in(&files, &from, &to))
            .await
            .map_err(|error| format!("Codex relocation task failed: {error}"))?
    }
}

/// The service's own `config.toml` plus every profile's.
fn config_files() -> Result<Vec<PathBuf>, crate::error::AppError> {
    let default = profiles::default_home().map(|home| home.join("config.toml"));
    let configured = profiles::list()?
        .into_iter()
        .filter_map(|profile| profile.config_path);
    let files: BTreeSet<PathBuf> = default
        .into_iter()
        .chain(configured)
        .map(|file| std::fs::canonicalize(&file).unwrap_or(file))
        .collect();
    Ok(files.into_iter().collect())
}

fn relocate_in(files: &[PathBuf], from: &Path, to: &Path) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    for file in files {
        notes.extend(move_folder_entries(file, from, to)?);
    }
    Ok(notes)
}

/// Carry the `projects` entries of `from` and of every folder under it.
fn move_folder_entries(file: &Path, from: &Path, to: &Path) -> Result<Vec<String>, String> {
    let text = match std::fs::read_to_string(file) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("could not read {}: {error}", file.display())),
    };
    let mut document: DocumentMut = text
        .parse()
        .map_err(|error| format!("{} is not valid TOML: {error}", file.display()))?;
    let Some(projects) = document
        .get_mut("projects")
        .and_then(|item| item.as_table_like_mut())
    else {
        return Ok(Vec::new());
    };
    let (moved, kept) = rekey(projects, from, to);
    if moved > 0 {
        write_atomic_in_place(file, &document.to_string())
            .map_err(|error| format!("could not write {}: {error}", file.display()))?;
    }
    Ok(kept
        .into_iter()
        .map(|key| {
            format!(
                "Codex trust for {key} stayed in {}: the new folder already has its own",
                file.display()
            )
        })
        .collect())
}

/// Rename the keys at or under `from` to the same place under `to`, keeping
/// entries the new keys already have. Returns how many moved and the keys
/// that stayed.
fn rekey(projects: &mut dyn TableLike, from: &Path, to: &Path) -> (usize, Vec<String>) {
    let renames: Vec<(String, String)> = projects
        .iter()
        .filter_map(|(key, _)| Some((key.to_string(), rebase_str(key, from, to)?)))
        .collect();
    let mut moved = 0;
    let mut kept = Vec::new();
    for (key, renamed) in renames {
        if projects.contains_key(&renamed) {
            kept.push(key);
            continue;
        }
        if let Some(entry) = projects.remove(&key) {
            projects.insert(&renamed, entry);
            moved += 1;
        }
    }
    (moved, kept)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(text: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("config.toml");
        std::fs::write(&file, text).unwrap();
        (root, file)
    }

    fn relocate(file: &Path) -> Vec<String> {
        relocate_in(
            &[file.to_path_buf()],
            Path::new("/repo/app"),
            Path::new("/repo/renamed"),
        )
        .unwrap()
    }

    #[test]
    fn trust_follows_the_folder_and_its_subfolders_and_the_rest_stays_as_written() {
        let (_root, file) = config(
            r#"model = "gpt-6.1-sol" # the default

[projects."/repo/app"]
trust_level = "trusted"

# a monorepo package
[projects."/repo/app/packages/web"]
trust_level = "untrusted"

[projects."/repo/app-other"]
trust_level = "trusted"
"#,
        );

        let notes = relocate(&file);

        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            r#"model = "gpt-6.1-sol" # the default

[projects."/repo/renamed"]
trust_level = "trusted"

# a monorepo package
[projects."/repo/renamed/packages/web"]
trust_level = "untrusted"

[projects."/repo/app-other"]
trust_level = "trusted"
"#
        );
    }

    #[test]
    fn inline_project_tables_follow_too() {
        let (_root, file) =
            config("projects = { \"/repo/app\" = { trust_level = \"trusted\" } }\n");

        relocate(&file);

        let document: DocumentMut = std::fs::read_to_string(&file).unwrap().parse().unwrap();
        assert_eq!(
            document["projects"]["/repo/renamed"]["trust_level"].as_str(),
            Some("trusted")
        );
        assert!(document["projects"].get("/repo/app").is_none());
    }

    #[test]
    fn trust_the_new_folder_already_has_is_kept() {
        let text = r#"[projects."/repo/app"]
trust_level = "trusted"

[projects."/repo/renamed"]
trust_level = "untrusted"
"#;
        let (_root, file) = config(text);

        let notes = relocate(&file);

        assert_eq!(notes.len(), 1, "{notes:?}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    }

    #[test]
    fn a_missing_file_or_one_without_projects_is_left_alone() {
        let root = tempfile::tempdir().unwrap();
        assert!(relocate(&root.path().join("config.toml")).is_empty());

        let (_root, file) = config("model = \"o3\"\n");
        assert!(relocate(&file).is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "model = \"o3\"\n");
    }

    #[test]
    fn invalid_toml_is_reported_and_not_rewritten() {
        let (_root, file) = config("[projects.\n");

        let error = relocate_in(
            std::slice::from_ref(&file),
            Path::new("/repo/app"),
            Path::new("/repo/renamed"),
        )
        .unwrap_err();

        assert!(error.contains("not valid TOML"), "{error}");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "[projects.\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_private_config_stays_private() {
        use std::os::unix::fs::PermissionsExt as _;
        let (_root, file) = config("[projects.\"/repo/app\"]\ntrust_level = \"trusted\"\n");
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();

        relocate(&file);

        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
