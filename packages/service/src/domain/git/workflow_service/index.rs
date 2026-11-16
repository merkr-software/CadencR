//! Guarded whole-file stage and unstage orchestration. Route wiring is owned
//! by the later single-owner API integration barrier.

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::{FileMutationBody, SuccessResponse};
use crate::domain::git::service::resolve_feature_git_dir;
use crate::error::AppError;

use super::{broadcast_after_write_at, mutation_guard_error, validate_file_mutation_path};

#[derive(Clone, Copy)]
enum IndexMutation {
    Stage,
    Reset,
}

pub async fn stage_file(
    state: &AppState,
    body: FileMutationBody,
) -> Result<SuccessResponse, AppError> {
    mutate_file(state, body, IndexMutation::Stage).await
}

pub async fn reset_file(
    state: &AppState,
    body: FileMutationBody,
) -> Result<SuccessResponse, AppError> {
    mutate_file(state, body, IndexMutation::Reset).await
}

async fn mutate_file(
    state: &AppState,
    body: FileMutationBody,
    mutation: IndexMutation,
) -> Result<SuccessResponse, AppError> {
    let dir = resolve_feature_git_dir(state, body.feature_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("feature {} has no git path", body.feature_id))
        })?;
    validate_file_mutation_path(&body.file_path)?;

    let permit = state
        .git_mutations
        .try_acquire(&dir.cwd)
        .map_err(|error| mutation_guard_error(error))?;
    match mutation {
        IndexMutation::Stage => commands::stage_file(&dir.root, &body.file_path).await?,
        IndexMutation::Reset => commands::reset_file(&dir.root, &body.file_path).await?,
    }
    drop(permit);

    broadcast_after_write_at(state, &dir.cwd).await;
    Ok(SuccessResponse {
        success: true,
        error: None,
        blocked_reason: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::path::Path;
    use std::process::Command;

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(repo)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", repo)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn init_repo(repo: &Path) {
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            git(repo, args);
        }
        std::fs::write(repo.join("seed.txt"), b"seed\n").unwrap();
        git(repo, &["add", "seed.txt"]);
        git(repo, &["commit", "-q", "-m", "seed"]);
    }

    async fn state_for(project_path: &Path, worktree_path: Option<&Path>) -> AppState {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', type TEXT NOT NULL DEFAULT 'ws-feature')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, path) VALUES (1, ?)")
            .bind(project_path.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (7, 1, 'feature')")
            .execute(&pool)
            .await
            .unwrap();
        if let Some(worktree_path) = worktree_path {
            sqlx::query(
                "INSERT INTO feature_settings (feature_id, key, value) VALUES (7, 'worktree_path', ?)",
            )
            .bind(worktree_path.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        }
        AppState::with_pool(pool)
    }

    #[tokio::test]
    async fn service_rejects_traversal_and_absolute_paths() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path());
        let state = state_for(temp.path(), None).await;

        for file_path in ["../outside", "/absolute", "dir/../file", "dir/"] {
            let error = stage_file(
                &state,
                FileMutationBody {
                    feature_id: 7,
                    file_path: file_path.into(),
                },
            )
            .await
            .unwrap_err();
            assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
        }
    }

    #[tokio::test]
    async fn service_mutates_the_resolved_linked_worktree() {
        let project = tempfile::tempdir().unwrap();
        init_repo(project.path());
        git(project.path(), &["branch", "feature"]);
        let worktrees = tempfile::tempdir().unwrap();
        let linked = worktrees.path().join("linked");
        git(
            project.path(),
            &["worktree", "add", "-q", linked.to_str().unwrap(), "feature"],
        );
        std::fs::write(linked.join("linked-only.txt"), b"linked\n").unwrap();
        let state = state_for(project.path(), Some(&linked)).await;

        stage_file(
            &state,
            FileMutationBody {
                feature_id: 7,
                file_path: "linked-only.txt".into(),
            },
        )
        .await
        .unwrap();

        assert_eq!(
            git(&linked, &["diff", "--cached", "--name-only"]).trim(),
            "linked-only.txt"
        );
        assert!(git(project.path(), &["diff", "--cached", "--name-only"])
            .trim()
            .is_empty());
    }

    #[tokio::test]
    async fn service_reports_a_busy_worktree_as_conflict() {
        let temp = tempfile::tempdir().unwrap();
        init_repo(temp.path());
        std::fs::write(temp.path().join("new.txt"), b"new\n").unwrap();
        let state = state_for(temp.path(), None).await;
        let _permit = state.git_mutations.try_acquire(temp.path()).unwrap();

        let error = reset_file(
            &state,
            FileMutationBody {
                feature_id: 7,
                file_path: "new.txt".into(),
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
    }
}
