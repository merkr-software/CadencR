//! Claude Code state that follows a moved project folder.
//!
//! Claude Code files a folder's transcripts and its auto-memory under
//! `<config>/projects/<encoded folder path>/`, and its per-folder settings
//! (trust, allowed tools, local MCP servers) under `projects["<path>"]` in
//! `.claude.json`. `--resume <id>` still finds a transcript left under the old
//! name, but memory is read from the new name only, and rewind/fork read the
//! transcript under the current folder's name. So both move, in every config
//! directory a profile uses.
//!
//! The transcript directory moves rather than being copied: Claude Code
//! resolves a session found in another project only when exactly one project
//! holds it.

use std::collections::BTreeSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::{Map, Value};

use super::config_dir;
use crate::domain::agents::relocation::{FolderMove, ProviderRelocator};
use crate::shared::atomic_file::write_atomic_in_place;
use crate::shared::no_replace_rename::rename_no_replace;
use crate::shared::path_rebase::{rebase_str, same_file};

#[derive(Debug)]
pub(crate) struct ClaudeRelocator;

#[async_trait]
impl ProviderRelocator for ClaudeRelocator {
    async fn relocate(&self, moved: FolderMove<'_>) -> Result<Vec<String>, String> {
        let (from, to, folders) = (
            moved.from.to_path_buf(),
            moved.to.to_path_buf(),
            moved.folders(),
        );
        let homes = config_homes().map_err(|error| error.to_string())?;
        tokio::task::spawn_blocking(move || relocate_in(&homes, &from, &to, &folders))
            .await
            .map_err(|error| format!("Claude Code relocation task failed: {error}"))?
    }
}

/// One place Claude Code keeps state: its config directory and user file.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ConfigHome {
    dir: PathBuf,
    user_file: PathBuf,
}

/// The service's own Claude Code home plus every profile's.
fn config_homes() -> Result<Vec<ConfigHome>, crate::error::AppError> {
    let profiles = super::profiles::list_profiles()?;
    let envs = std::iter::once(None).chain(profiles.iter().map(|profile| Some(&profile.env)));
    let homes: BTreeSet<ConfigHome> = envs
        .filter_map(|env| {
            Some(ConfigHome {
                dir: config_dir::for_env(env)?,
                user_file: config_dir::user_file_for_env(env)?,
            })
        })
        .collect();
    Ok(homes.into_iter().collect())
}

/// `folders` are the conversation folders that moved, as `(old, new)`: each
/// has its own transcript directory. The settings of `from` and of every
/// folder under it follow too.
fn relocate_in(
    homes: &[ConfigHome],
    from: &Path,
    to: &Path,
    folders: &[(PathBuf, PathBuf)],
) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    for home in homes {
        for (old, new) in folders {
            notes.extend(move_transcripts(&home.dir, old, new)?);
        }
        notes.extend(move_folder_settings(&home.user_file, from, to)?);
    }
    Ok(notes)
}

fn move_transcripts(config: &Path, from: &Path, to: &Path) -> Result<Vec<String>, String> {
    let source = config_dir::transcripts_dir(config, from);
    let target = config_dir::transcripts_dir(config, to);
    if source == target || !source.is_dir() {
        return Ok(Vec::new());
    }
    if same_file(&source, &target) {
        // Only the letter case changed, on a case-insensitive volume.
        return std::fs::rename(&source, &target)
            .map(|()| Vec::new())
            .map_err(|error| move_error(&source, &target, &error));
    }
    match rename_no_replace(&source, &target) {
        Ok(()) => return Ok(Vec::new()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(move_error(&source, &target, &error)),
    }
    let mut kept = 0;
    merge_into(&source, &target, &mut kept)?;
    if kept == 0 {
        remove_empty_dir(&source)?;
        return Ok(Vec::new());
    }
    Ok(vec![format!(
        "{kept} Claude Code file(s) stayed in {}: {} already has files with the same names",
        source.display(),
        target.display()
    )])
}

/// Move every entry of `source` into `target`, descending into directories
/// both hold (`memory/`). An entry `target` already has stays where it is.
fn merge_into(source: &Path, target: &Path, kept: &mut usize) -> Result<(), String> {
    let entries = std::fs::read_dir(source).map_err(|error| read_error(source, &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| read_error(source, &error))?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        match rename_no_replace(&from, &to) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                if from.is_dir() && to.is_dir() {
                    let before = *kept;
                    merge_into(&from, &to, kept)?;
                    if *kept == before {
                        remove_empty_dir(&from)?;
                    }
                } else {
                    *kept += 1;
                }
            }
            Err(error) => return Err(move_error(&from, &to, &error)),
        }
    }
    Ok(())
}

fn remove_empty_dir(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

/// Carry the `projects` entries of `from` and of every folder under it.
fn move_folder_settings(user_file: &Path, from: &Path, to: &Path) -> Result<Vec<String>, String> {
    let text = match std::fs::read_to_string(user_file) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(read_error(user_file, &error)),
    };
    let mut document: Value = serde_json::from_str(&text)
        .map_err(|error| format!("{} is not valid JSON: {error}", user_file.display()))?;
    let Some(projects) = document.get_mut("projects").and_then(Value::as_object_mut) else {
        return Ok(Vec::new());
    };
    let (moved, kept) = rekey(projects, from, to);
    if moved > 0 {
        let text = serde_json::to_string_pretty(&document)
            .map_err(|error| format!("could not serialize {}: {error}", user_file.display()))?;
        write_atomic_in_place(user_file, &text)
            .map_err(|error| format!("could not write {}: {error}", user_file.display()))?;
    }
    Ok(kept
        .into_iter()
        .map(|key| {
            format!(
                "Claude Code settings for {key} stayed in {}: the new folder already has its own",
                user_file.display()
            )
        })
        .collect())
}

/// Rename the keys at or under `from` to the same place under `to`, keeping
/// entries the new keys already have. Returns how many moved and the keys
/// that stayed.
fn rekey(projects: &mut Map<String, Value>, from: &Path, to: &Path) -> (usize, Vec<String>) {
    let renames: Vec<(String, String)> = projects
        .keys()
        .filter_map(|key| Some((key.clone(), rebase_str(key, from, to)?)))
        .collect();
    let mut moved = 0;
    let mut kept = Vec::new();
    for (key, renamed) in renames {
        if projects.contains_key(&renamed) {
            kept.push(key);
            continue;
        }
        if let Some(value) = projects.remove(&key) {
            projects.insert(renamed, value);
            moved += 1;
        }
    }
    (moved, kept)
}

fn read_error(path: &Path, error: &std::io::Error) -> String {
    format!("could not read {}: {error}", path.display())
}

fn move_error(from: &Path, to: &Path, error: &std::io::Error) -> String {
    format!(
        "could not move {} to {}: {error}",
        from.display(),
        to.display()
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn home(root: &Path) -> ConfigHome {
        let dir = root.join(".claude");
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        ConfigHome {
            user_file: root.join(".claude.json"),
            dir,
        }
    }

    fn projects_dir(home: &ConfigHome, folder: &str) -> PathBuf {
        config_dir::transcripts_dir(&home.dir, Path::new(folder))
    }

    /// `/repo/app` → `/repo/renamed`, with no inner conversation folder.
    fn relocate(home: &ConfigHome) -> Vec<String> {
        let (from, to) = (Path::new("/repo/app"), Path::new("/repo/renamed"));
        let folders = FolderMove {
            from,
            to,
            inner: &[],
        }
        .folders();
        relocate_in(std::slice::from_ref(home), from, to, &folders).unwrap()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn history_and_memory_follow_the_folder() {
        let root = tempfile::tempdir().unwrap();
        let home = home(root.path());
        let old = projects_dir(&home, "/repo/app");
        write(&old.join("s1.jsonl"), "{}");
        write(&old.join("memory/MEMORY.md"), "- fact");

        let notes = relocate(&home);

        assert!(notes.is_empty(), "{notes:?}");
        let new = projects_dir(&home, "/repo/renamed");
        assert!(new.join("s1.jsonl").is_file());
        assert!(new.join("memory/MEMORY.md").is_file());
        assert!(!old.exists());
    }

    #[test]
    fn an_existing_new_folder_receives_the_files_it_lacks() {
        let root = tempfile::tempdir().unwrap();
        let home = home(root.path());
        let old = projects_dir(&home, "/repo/app");
        let new = projects_dir(&home, "/repo/renamed");
        write(&old.join("s1.jsonl"), "old");
        write(&old.join("memory/a.md"), "a");
        write(&old.join("memory/MEMORY.md"), "old index");
        write(&new.join("memory/MEMORY.md"), "new index");

        let notes = relocate(&home);

        assert!(new.join("s1.jsonl").is_file());
        assert!(new.join("memory/a.md").is_file());
        assert_eq!(
            std::fs::read_to_string(new.join("memory/MEMORY.md")).unwrap(),
            "new index"
        );
        assert!(
            old.join("memory/MEMORY.md").is_file(),
            "the clash stays put"
        );
        assert_eq!(notes.len(), 1, "{notes:?}");
    }

    #[test]
    fn folder_settings_follow_the_folder_and_its_subfolders_only() {
        let root = tempfile::tempdir().unwrap();
        let home = home(root.path());
        write(
            &home.user_file,
            &json!({
                "numStartups": 3,
                "projects": {
                    "/repo/app": { "hasTrustDialogAccepted": true },
                    "/repo/app/packages/web": { "allowedTools": ["Bash"] },
                    "/repo/app-other": { "hasTrustDialogAccepted": false },
                }
            })
            .to_string(),
        );

        relocate(&home);

        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(&home.user_file).unwrap()).unwrap();
        let projects = document["projects"].as_object().unwrap();
        assert_eq!(projects.len(), 3);
        assert_eq!(
            projects["/repo/renamed"]["hasTrustDialogAccepted"],
            json!(true)
        );
        assert_eq!(
            projects["/repo/renamed/packages/web"]["allowedTools"],
            json!(["Bash"])
        );
        assert_eq!(
            projects["/repo/app-other"]["hasTrustDialogAccepted"],
            json!(false)
        );
        assert_eq!(document["numStartups"], json!(3));
    }

    #[test]
    fn settings_the_new_folder_already_has_are_kept() {
        let mut projects = Map::new();
        projects.insert("/repo/app".into(), json!({ "a": 1 }));
        projects.insert("/repo/renamed".into(), json!({ "b": 2 }));

        let (moved, kept) = rekey(
            &mut projects,
            Path::new("/repo/app"),
            Path::new("/repo/renamed"),
        );

        assert_eq!((moved, kept), (0, vec!["/repo/app".to_string()]));
        assert_eq!(projects["/repo/renamed"], json!({ "b": 2 }));
    }

    #[test]
    fn nothing_to_carry_is_not_an_error() {
        let root = tempfile::tempdir().unwrap();
        let home = home(root.path());

        let notes = relocate(&home);

        assert!(notes.is_empty());
    }

    #[test]
    fn a_worktree_kept_inside_the_project_brings_its_history_along() {
        let root = tempfile::tempdir().unwrap();
        let home = home(root.path());
        let old = projects_dir(&home, "/repo/app/.worktrees/feat");
        write(&old.join("s2.jsonl"), "{}");
        let (from, to) = (Path::new("/repo/app"), Path::new("/repo/renamed"));
        let inner = [PathBuf::from("/repo/app/.worktrees/feat")];
        let folders = FolderMove {
            from,
            to,
            inner: &inner,
        }
        .folders();

        relocate_in(std::slice::from_ref(&home), from, to, &folders).unwrap();

        let new = projects_dir(&home, "/repo/renamed/.worktrees/feat");
        assert!(new.join("s2.jsonl").is_file());
        assert!(!old.exists());
    }

    #[test]
    fn a_change_of_case_renames_the_history_instead_of_reporting_clashes() {
        let root = tempfile::tempdir().unwrap();
        let home = home(root.path());
        let old = projects_dir(&home, "/repo/app");
        write(&old.join("s1.jsonl"), "{}");
        let (from, to) = (Path::new("/repo/app"), Path::new("/repo/App"));
        let folders = FolderMove {
            from,
            to,
            inner: &[],
        }
        .folders();

        let notes = relocate_in(std::slice::from_ref(&home), from, to, &folders).unwrap();

        assert!(notes.is_empty(), "{notes:?}");
        let new = projects_dir(&home, "/repo/App");
        let names: Vec<_> = std::fs::read_dir(new.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![new.file_name().unwrap().to_owned()]);
        assert!(new.join("s1.jsonl").is_file());
    }
}
