//! Where a project folder may go, checked before anything changes.

use std::path::{Component, Path, PathBuf};

use crate::domain::projects::models::ProjectFolderMode;
use crate::error::AppError;
use crate::shared::path_rebase::same_file;

/// A validated folder change: the project leaves `from` for `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FolderPlan {
    pub(super) from: PathBuf,
    pub(super) to: PathBuf,
    pub(super) mode: ProjectFolderMode,
}

pub(super) fn plan(
    current: &str,
    requested: &str,
    mode: ProjectFolderMode,
) -> Result<FolderPlan, AppError> {
    let from = PathBuf::from(current);
    let to = resolved(normalized(requested)?, mode);
    if to == from {
        return Err(AppError::BadRequest(format!(
            "The project is already at {}",
            to.display()
        )));
    }
    match mode {
        ProjectFolderMode::Move => check_move(&from, &to)?,
        ProjectFolderMode::Locate => check_locate(&from, &to)?,
    }
    Ok(FolderPlan { from, to, mode })
}

/// An absolute path without `.` or `..`, and without a trailing separator.
fn normalized(requested: &str) -> Result<PathBuf, AppError> {
    let requested = requested.trim();
    let path = Path::new(requested);
    if requested.is_empty() || !path.is_absolute() {
        return Err(AppError::BadRequest(format!(
            "The new location must be an absolute path, not {requested:?}"
        )));
    }
    if path
        .components()
        .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err(AppError::BadRequest(format!(
            "The new location must not contain . or .. ({requested})"
        )));
    }
    Ok(path.components().collect())
}

/// `to` spelled the way project creation records folders: without symlinks
/// (`/tmp` → `/private/tmp` on macOS). A folder still to be created keeps the
/// name the user typed under its resolved parent.
fn resolved(to: PathBuf, mode: ProjectFolderMode) -> PathBuf {
    match mode {
        ProjectFolderMode::Locate => to.canonicalize().unwrap_or(to),
        ProjectFolderMode::Move => {
            let parent = to.parent().and_then(|parent| parent.canonicalize().ok());
            match (parent, to.file_name()) {
                (Some(parent), Some(name)) => parent.join(name),
                _ => to,
            }
        }
    }
}

fn check_move(from: &Path, to: &Path) -> Result<(), AppError> {
    if !from.is_dir() {
        return Err(AppError::Conflict(format!(
            "The project folder {} no longer exists; locate it instead",
            from.display()
        )));
    }
    if std::fs::symlink_metadata(to).is_ok() && !same_file(from, to) {
        return Err(AppError::Conflict(format!(
            "{} already exists",
            to.display()
        )));
    }
    let parent = to
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "The folder that should hold {} does not exist",
                to.display()
            ))
        })?;
    if inside(parent, from) {
        return Err(AppError::BadRequest(
            "A project folder cannot move inside itself".into(),
        ));
    }
    Ok(())
}

fn check_locate(from: &Path, to: &Path) -> Result<(), AppError> {
    if from.exists() {
        return Err(AppError::Conflict(format!(
            "The project folder is still at {}; rename or move it instead",
            from.display()
        )));
    }
    if !to.is_dir() {
        return Err(AppError::BadRequest(format!(
            "{} is not a folder",
            to.display()
        )));
    }
    Ok(())
}

/// `path` is `folder` or inside it, also through symlinks.
fn inside(path: &Path, folder: &Path) -> bool {
    match (path.canonicalize(), folder.canonicalize()) {
        (Ok(path), Ok(folder)) => path.starts_with(folder),
        _ => path.starts_with(folder),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folders() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("app");
        std::fs::create_dir(&project).unwrap();
        (root, project)
    }

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn a_free_sibling_name_is_accepted() {
        let (root, project) = folders();
        let to = root.path().join("renamed");

        let plan = plan(
            &text(&project),
            &format!("{}/", text(&to)),
            ProjectFolderMode::Move,
        )
        .unwrap();

        let resolved = root.path().canonicalize().unwrap().join("renamed");
        assert_eq!(plan.to, resolved, "the trailing separator is dropped");
    }

    #[cfg(unix)]
    #[test]
    fn the_destination_is_recorded_without_symlinks() {
        let (root, project) = folders();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let real = real.canonicalize().unwrap();

        let moved = plan(
            &text(&project),
            &text(&link.join("App")),
            ProjectFolderMode::Move,
        )
        .unwrap();
        std::fs::create_dir(real.join("found")).unwrap();
        std::fs::remove_dir(&project).unwrap();
        let located = plan(
            &text(&project),
            &text(&link.join("found")),
            ProjectFolderMode::Locate,
        )
        .unwrap();

        assert_eq!(moved.to, real.join("App"), "the typed name is kept");
        assert_eq!(located.to, real.join("found"));
    }

    #[test]
    fn a_taken_name_is_refused() {
        let (root, project) = folders();
        std::fs::create_dir(root.path().join("taken")).unwrap();

        let error = plan(
            &text(&project),
            &text(&root.path().join("taken")),
            ProjectFolderMode::Move,
        )
        .unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
    }

    #[test]
    fn relative_parent_and_nested_destinations_are_refused() {
        let (root, project) = folders();
        for requested in [
            "renamed".to_string(),
            format!("{}/../x", text(root.path())),
            text(&project.join("inner")),
            text(&root.path().join("missing/renamed")),
        ] {
            let error = plan(&text(&project), &requested, ProjectFolderMode::Move).unwrap_err();
            assert!(
                matches!(error, AppError::BadRequest(_)),
                "{requested}: {error:?}"
            );
        }
    }

    #[test]
    fn moving_a_missing_folder_asks_to_locate_it() {
        let root = tempfile::tempdir().unwrap();
        let gone = root.path().join("gone");

        let error = plan(
            &text(&gone),
            &text(&root.path().join("renamed")),
            ProjectFolderMode::Move,
        )
        .unwrap_err();

        assert!(error.to_string().contains("locate"), "{error}");
    }

    #[test]
    fn locating_needs_the_old_folder_gone_and_the_new_one_present() {
        let (root, project) = folders();
        let moved = root.path().join("moved");

        let still_there =
            plan(&text(&project), &text(&moved), ProjectFolderMode::Locate).unwrap_err();
        assert!(matches!(still_there, AppError::Conflict(_)));

        std::fs::rename(&project, &moved).unwrap();
        let located = plan(&text(&project), &text(&moved), ProjectFolderMode::Locate).unwrap();
        assert_eq!(located.to, moved.canonicalize().unwrap());

        let missing = plan(
            &text(&project),
            &text(&root.path().join("nowhere")),
            ProjectFolderMode::Locate,
        )
        .unwrap_err();
        assert!(matches!(missing, AppError::BadRequest(_)));
    }
}
