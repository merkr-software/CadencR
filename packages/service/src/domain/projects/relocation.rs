//! Renaming a project, and moving its folder.
//!
//! A rename alone changes the name (and the settings document named after
//! it). A folder change also moves the folder — or, when the user moved it
//! already, only records where it went — then carries along what is filed
//! under the old path: the project's records, the links of its git
//! worktrees, the providers' own state, and the live conversations' folder.
//! Worktrees Cadencr created stay where they are.

mod destination;
mod folder_move;
mod records;
mod worktrees;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::app_state::AppState;
use crate::domain::agents::providers::provider_registry;
use crate::domain::agents::relocation::FolderMove;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::features::run_registry::FeatureRunPermit;
use crate::domain::projects::models::{
    Project, ProjectFolderChange, ProjectFolderMode, UpdateProjectRequest, UpdateProjectResponse,
};
use crate::domain::projects::repository;
use crate::domain::projects::service::validate_project_name;
use crate::domain::settings_store;
use crate::domain::ws_session::runtime::relocation::hold_for_relocation;
use crate::error::AppError;

use destination::FolderPlan;
use folder_move::Moved;
use records::RecordChange;

pub async fn update_project(
    state: &AppState,
    project_id: i64,
    request: UpdateProjectRequest,
) -> Result<UpdateProjectResponse, AppError> {
    let project = repository::get_project(&state.read_pool, project_id).await?;
    let name = new_name(&project, request.name.as_deref())?;
    if (name.is_some() || request.folder.is_some()) && project.authoring_target.is_some() {
        return Err(AppError::BadRequest(
            "Cadencr names and places plugin authoring projects itself".into(),
        ));
    }
    let _running = state
        .project_relocations
        .try_acquire(project_id)
        .ok_or_else(|| {
            AppError::Conflict("This project is already being renamed or moved".into())
        })?;
    let (warnings, original_left_at) = match request.folder {
        Some(change) => relocate(state, &project, name.as_deref(), change).await?,
        None => {
            if let Some(name) = name.as_deref() {
                rename(&state.write_pool, project_id, name).await?;
            }
            (Vec::new(), None)
        }
    };
    Ok(UpdateProjectResponse {
        project: repository::get_project(&state.read_pool, project_id).await?,
        warnings,
        original_left_at,
    })
}

/// The requested name when it differs from the current one, in the shape
/// project creation accepts.
fn new_name(project: &Project, requested: Option<&str>) -> Result<Option<String>, AppError> {
    match requested {
        Some(requested) if requested.trim() != project.name => {
            validate_project_name(requested).map(Some)
        }
        _ => Ok(None),
    }
}

async fn relocate(
    state: &AppState,
    project: &Project,
    name: Option<&str>,
    change: ProjectFolderChange,
) -> Result<(Vec<String>, Option<String>), AppError> {
    let plan = destination::plan(&project.path, &change.path, change.mode)?;
    // Records may spell the folder through a symlink; only the old folder
    // can say so, before it moves.
    let spellings = spellings(&plan.from);
    let spellings: Vec<&Path> = spellings.iter().map(PathBuf::as_path).collect();
    refuse_conflicts(state, project.id, &plan, &spellings).await?;
    let features = records::features(&state.read_pool, project.id).await?;
    let feature_ids: HashSet<i64> = features.iter().map(|&(id, _)| id).collect();
    let _runs = claim_feature_runs(state, &feature_ids)?;
    let hold = hold_for_relocation(state, &feature_ids)
        .await
        .map_err(AppError::Conflict)?;
    let moved = match plan.mode {
        ProjectFolderMode::Move => Some(folder_move::move_folder(&plan.from, &plan.to).await?),
        ProjectFolderMode::Locate => None,
    };
    let folder = Some((spellings.as_slice(), plan.to.as_path()));
    let inner = match record(&state.write_pool, project.id, name, folder).await {
        Ok(inner) => inner,
        Err(error) => return Err(undo_move(&plan, moved, error).await),
    };
    let warnings = follow(&plan, &inner).await;
    hold.release_into(&spellings, &plan.to).await;
    // Archived conversations show no folder until they are reopened.
    for &(feature_id, _) in features.iter().filter(|&&(_, archived)| !archived) {
        state
            .feature_events_tx
            .emit(feature_id, Some(project.id), FeatureEventAction::Updated);
    }
    let original_left_at =
        (moved == Some(Moved::Copied)).then(|| plan.from.to_string_lossy().into_owned());
    Ok((warnings, original_left_at))
}

/// Another project at the destination, or inside the folder that moves
/// (it would move along behind its back).
async fn refuse_conflicts(
    state: &AppState,
    project_id: i64,
    plan: &FolderPlan,
    spellings: &[&Path],
) -> Result<(), AppError> {
    if let Some(other) = records::project_at(&state.read_pool, &plan.to, project_id).await? {
        return Err(AppError::Conflict(format!(
            "The project \"{other}\" already uses {}",
            plan.to.display()
        )));
    }
    if plan.mode == ProjectFolderMode::Move {
        if let Some(other) =
            records::project_inside(&state.read_pool, spellings, project_id).await?
        {
            return Err(AppError::Conflict(format!(
                "The project \"{other}\" lives inside this folder; it would move along without \
                 Cadencr following it"
            )));
        }
    }
    Ok(())
}

/// Keep worktree setups and archive cleanups — both run git against the
/// repository — from starting while it moves; refused while one runs.
fn claim_feature_runs(
    state: &AppState,
    features: &HashSet<i64>,
) -> Result<Vec<FeatureRunPermit>, AppError> {
    let mut permits = Vec::with_capacity(features.len() * 2);
    for &feature_id in features {
        let setup = state
            .worktree_setup_runs
            .try_acquire(feature_id)
            .ok_or_else(|| {
                AppError::Conflict(
                    "A worktree setup is running in this project; wait for it to finish".into(),
                )
            })?;
        let cleanup = state
            .archive_cleanup_runs
            .try_acquire(feature_id)
            .ok_or_else(|| {
                AppError::Conflict(
                    "An archive cleanup is running in this project; wait for it to finish".into(),
                )
            })?;
        permits.extend([setup, cleanup]);
    }
    Ok(permits)
}

fn spellings(from: &Path) -> Vec<PathBuf> {
    let mut spellings = vec![from.to_path_buf()];
    if let Ok(resolved) = from.canonicalize() {
        if resolved != from {
            spellings.push(resolved);
        }
    }
    spellings
}

/// Rename a project's records and its settings without moving its folder.
pub(crate) async fn rename(pool: &SqlitePool, project_id: i64, name: &str) -> Result<(), AppError> {
    record(pool, project_id, Some(name), None).await.map(drop)
}

/// Record the new name and folder. The settings document is named after the
/// project, so it moves first, while the old name still finds it, and moves
/// back when the records refuse the change. Returns the conversation folders
/// that moved along inside the old one.
async fn record(
    pool: &SqlitePool,
    project_id: i64,
    name: Option<&str>,
    folder: Option<(&[&Path], &Path)>,
) -> Result<Vec<PathBuf>, AppError> {
    let settings_rename = match name {
        Some(name) => Some(settings_store::project_rename(pool, project_id, name).await?),
        None => None,
    };
    let change = RecordChange { name, folder };
    let error = match records::apply(pool, project_id, &change).await {
        Ok(inner) => return Ok(inner),
        Err(error) => error,
    };
    let Some(settings_rename) = settings_rename else {
        return Err(error);
    };
    match settings_rename.undo() {
        Ok(()) => Err(error),
        Err(undo) => Err(AppError::internal(format!(
            "{error}; the project settings could not be renamed back either ({undo})"
        ))),
    }
}

/// Put the folder back after the records refused the change, so the project
/// still matches its folder.
async fn undo_move(plan: &FolderPlan, moved: Option<Moved>, error: AppError) -> AppError {
    let Some(moved) = moved else {
        return error;
    };
    match folder_move::undo(&plan.from, &plan.to, moved).await {
        Ok(()) => error,
        Err(undo) => AppError::internal(format!(
            "{error}; the folder could not be put back either ({undo}): the project folder \
             is now at {} while Cadencr still records {}",
            plan.to.display(),
            plan.from.display()
        )),
    }
}

/// Carry along what is filed under the old path. Each failure becomes a
/// warning: the folder already moved and the records already follow it.
async fn follow(plan: &FolderPlan, inner: &[PathBuf]) -> Vec<String> {
    let mut warnings = match worktrees::linked_worktrees(&plan.to, &plan.from).await {
        Ok(linked) => worktrees::repair(&plan.to, &linked).await,
        Err(error) => vec![error],
    };
    let moved = FolderMove {
        from: &plan.from,
        to: &plan.to,
        inner,
    };
    for provider in provider_registry().iter() {
        let Some(relocator) = provider.metadata().relocator() else {
            continue;
        };
        match relocator.relocate(moved).await {
            Ok(notes) => warnings.extend(notes),
            Err(error) => warnings.push(format!("{}: {error}", provider.id())),
        }
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::projects::models::ProjectFolderChange;
    use crate::shared::git_cli::run_git;

    async fn state() -> AppState {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        AppState::with_pool(pool)
    }

    /// A repository at `<root>/app` with one linked worktree outside it,
    /// recorded as project `app` with one conversation on that worktree.
    async fn project(state: &AppState, root: &Path) -> (i64, PathBuf) {
        let repo = root.join("app");
        std::fs::create_dir(&repo).unwrap();
        let git = |args: Vec<String>, cwd: PathBuf| async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            run_git(&args, &cwd).await.unwrap();
        };
        git(vec!["init".into(), "-q".into()], repo.clone()).await;
        git(
            [
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "i",
            ]
            .map(String::from)
            .to_vec(),
            repo.clone(),
        )
        .await;
        let worktree = root.join("worktrees/feat");
        git(
            vec![
                "worktree".into(),
                "add".into(),
                "-q".into(),
                "-b".into(),
                "feat".into(),
                worktree.to_string_lossy().into(),
            ],
            repo.clone(),
        )
        .await;
        let project_id: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES ('app', ?) RETURNING id")
                .bind(repo.to_string_lossy().as_ref())
                .fetch_one(&state.write_pool)
                .await
                .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title, status) VALUES (?, 'f', 'active') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&state.write_pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES (?, 'worktree_path', ?)",
        )
        .bind(feature_id)
        .bind(worktree.to_string_lossy().as_ref())
        .execute(&state.write_pool)
        .await
        .unwrap();
        (project_id, worktree)
    }

    #[tokio::test]
    async fn renaming_the_folder_keeps_the_project_and_its_worktrees_working() {
        let state = state().await;
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (project_id, worktree) = project(&state, &root).await;
        let to = root.join("renamed");

        let response = update_project(
            &state,
            project_id,
            UpdateProjectRequest {
                name: Some("Renamed".into()),
                folder: Some(ProjectFolderChange {
                    path: to.to_string_lossy().into(),
                    mode: ProjectFolderMode::Move,
                }),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.project.name, "Renamed");
        assert_eq!(response.project.path, to.to_string_lossy());
        assert!(!response.project.path_missing);
        assert!(response.original_left_at.is_none());
        assert!(to.join(".git").is_dir() && !root.join("app").exists());
        run_git(&["status"], &worktree)
            .await
            .expect("the worktree is linked to the moved repository");
    }

    #[tokio::test]
    async fn a_folder_moved_outside_cadencr_can_be_located() {
        let state = state().await;
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let (project_id, worktree) = project(&state, &root).await;
        let to = root.join("moved-by-hand");
        std::fs::rename(root.join("app"), &to).unwrap();
        let missing = repository::get_project(&state.read_pool, project_id)
            .await
            .unwrap();
        assert!(missing.path_missing);

        let response = update_project(
            &state,
            project_id,
            UpdateProjectRequest {
                name: None,
                folder: Some(ProjectFolderChange {
                    path: to.to_string_lossy().into(),
                    mode: ProjectFolderMode::Locate,
                }),
            },
        )
        .await
        .unwrap();

        assert_eq!(response.project.name, "app");
        assert!(!response.project.path_missing);
        run_git(&["status"], &worktree).await.expect("repaired");
    }

    #[tokio::test]
    async fn a_name_alone_leaves_the_folder_in_place() {
        let state = state().await;
        let root = tempfile::tempdir().unwrap();
        let (project_id, _) = project(&state, root.path()).await;

        let response = update_project(
            &state,
            project_id,
            UpdateProjectRequest {
                name: Some("  New name ".into()),
                folder: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(response.project.name, "New name");
        assert!(root.path().join("app").is_dir());
        let blank = UpdateProjectRequest {
            name: Some(" ".into()),
            folder: None,
        };
        assert!(update_project(&state, project_id, blank).await.is_err());
    }

    async fn assert_rename_rejected(state: &AppState, project: &Project, name: &str) {
        sqlx::query(
            "CREATE TRIGGER reject_project_rename BEFORE UPDATE OF name ON projects \
             BEGIN SELECT RAISE(ABORT, 'test rejects project rename'); END",
        )
        .execute(&state.write_pool)
        .await
        .unwrap();

        let error = update_project(
            state,
            project.id,
            UpdateProjectRequest {
                name: Some(name.into()),
                folder: None,
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::DatabaseError(_)), "{error}");
        assert!(error.to_string().contains("test rejects project rename"));
        let saved = repository::get_project(&state.read_pool, project.id)
            .await
            .unwrap();
        assert_eq!(saved.name, project.name);
    }

    #[tokio::test]
    async fn a_rejected_rename_leaves_the_existing_destination_settings_in_place() {
        let state = state().await;
        let root = tempfile::tempdir().unwrap();
        let source = repository::create_project(
            &state.write_pool,
            "Source",
            root.path().join("source").to_str().unwrap(),
        )
        .await
        .unwrap();
        let destination = repository::create_project(
            &state.write_pool,
            "Destination",
            root.path().join("destination").to_str().unwrap(),
        )
        .await
        .unwrap();
        settings_store::project_set(&state.write_pool, destination.id, "model_session", "sonnet")
            .await
            .unwrap();
        let source_path = settings_store::project_path(&state.read_pool, source.id)
            .await
            .unwrap();
        let destination_path = settings_store::project_path(&state.read_pool, destination.id)
            .await
            .unwrap();
        let destination_bytes = std::fs::read(&destination_path).unwrap();

        assert_rename_rejected(&state, &source, &destination.name).await;

        assert!(!source_path.exists());
        assert_eq!(std::fs::read(&destination_path).unwrap(), destination_bytes);
    }

    #[tokio::test]
    async fn a_rejected_rename_restores_the_settings_it_moved() {
        let state = state().await;
        let root = tempfile::tempdir().unwrap();
        let source =
            repository::create_project(&state.write_pool, "Source", root.path().to_str().unwrap())
                .await
                .unwrap();
        settings_store::project_set(&state.write_pool, source.id, "model_session", "opus")
            .await
            .unwrap();
        let source_path = settings_store::project_path(&state.read_pool, source.id)
            .await
            .unwrap();
        let source_bytes = std::fs::read(&source_path).unwrap();

        assert_rename_rejected(&state, &source, "Fresh name").await;

        assert_eq!(std::fs::read(&source_path).unwrap(), source_bytes);
        let destination_path = settings_store::paths::project_file_for_name(
            &settings_store::global_dir(),
            "Fresh name",
        );
        assert!(!destination_path.exists());
    }
}
