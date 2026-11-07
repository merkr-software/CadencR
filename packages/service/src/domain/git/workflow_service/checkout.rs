//! `POST /api/git/checkout/validate` and `POST /api/git/checkout` — switch
//! the project repo to a branch chosen by the user in the branch picker.
//!
//! - **validate**: heuristic dry-run (no HEAD movement, no `post-checkout`
//!   hooks). Reads the dirty tracked-file set first and intersects it with
//!   `git diff --name-only HEAD <ref>`; returns a git-style overwrite error
//!   when non-empty. The clean working tree short-circuits before the diff
//!   even runs.
//! - **checkout**: authoritative `git checkout`. `run_git_capture` returns
//!   git's verbatim stderr (home-dir scrubbed) in `AppError::GitRejected`
//!   on failure — returned as a 4xx `{error, code}` the toast surfaces as-is
//!   (dirty-tree overlap → 409 `GIT_LOCAL_CHANGES_CONFLICT`, unknown branch →
//!   422 `GIT_REF_NOT_FOUND`).

use std::collections::HashSet;
use std::path::Path;

use axum::extract::{Json, State};

use crate::app_state::AppState;
use crate::domain::git::models::{CheckoutBody, CheckoutValidateBody, SuccessResponse};
use crate::domain::git::repository;
use crate::error::AppError;
use crate::shared::git_cli::{run_git_capture, run_git_safe_refs};

use super::{local_branch_exists, remote_branch_exists};

// Handlers live alongside the service implementation so the routes catalog
// stays under the 400-line cap. `routes.rs` re-exports both.

#[utoipa::path(
    post,
    path = "/api/git/checkout",
    request_body = CheckoutBody,
    responses((status = 200, body = SuccessResponse))
)]
pub async fn checkout_branch_handler(
    State(state): State<AppState>,
    Json(body): Json<CheckoutBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(checkout(&state, body).await?))
}

#[utoipa::path(
    post,
    path = "/api/git/checkout/validate",
    request_body = CheckoutValidateBody,
    responses((status = 200, body = SuccessResponse))
)]
pub async fn validate_checkout_handler(
    State(state): State<AppState>,
    Json(body): Json<CheckoutValidateBody>,
) -> Result<Json<SuccessResponse>, AppError> {
    Ok(Json(validate_checkout(&state, body).await?))
}

async fn validate_checkout(
    state: &AppState,
    body: CheckoutValidateBody,
) -> Result<SuccessResponse, AppError> {
    let (project_path, resolved) = prepare(state, body.project_id, &body.branch).await?;
    let repo = Path::new(&project_path);

    // Clean working tree → checkout is always safe. Skips the (expensive on
    // large repos) tree-diff entirely for the common case.
    //
    // TODO(#26): this `git status` is a read but still goes through the
    // default (potentially lock-taking) path. The race window is narrow
    // here (single user-initiated call, not a polling loop), so we accept
    // it for now rather than duplicate `run_git_safe_refs` into a
    // `_background` variant. Revisit if a real-world race ever surfaces.
    let status = run_git_safe_refs(&["status"], &["--porcelain", "-uno"], &[], repo).await?;
    let dirty_files = parse_porcelain_dirty_files(&status);
    if dirty_files.is_empty() {
        return Ok(SuccessResponse::ok());
    }

    let diff = run_git_safe_refs(
        &["diff"],
        &["--name-only", "--no-renames", "HEAD"],
        &[&resolved],
        repo,
    )
    .await?;
    let diff_files: HashSet<&str> = diff
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let overlap: Vec<String> = dirty_files
        .into_iter()
        .filter(|p| diff_files.contains(p.as_str()))
        .collect();
    if overlap.is_empty() {
        return Ok(SuccessResponse::ok());
    }
    let mut overlap = overlap;
    overlap.sort();
    overlap.dedup();
    Err(AppError::git_rejected(format_overwrite_error(&overlap)))
}

async fn checkout(state: &AppState, body: CheckoutBody) -> Result<SuccessResponse, AppError> {
    let (project_path, resolved) = prepare(state, body.project_id, &body.branch).await?;
    let repo = Path::new(&project_path);
    let _permit = state
        .git_mutations
        .try_acquire(repo)
        .map_err(super::mutation_guard_error)?;
    run_git_capture(&["checkout"], &[], &[&resolved], repo).await?;
    Ok(SuccessResponse::ok())
}

/// Validate inputs, look up the project path, and resolve the user-supplied
/// branch name to the local name we'll hand to `git checkout` (DWIM strips
/// the leading `<remote>/` when the pick is a remote-tracking ref).
async fn prepare(
    state: &AppState,
    project_id: i64,
    branch: &str,
) -> Result<(String, String), AppError> {
    if branch.trim().is_empty() {
        return Err(AppError::BadRequest("branch is required".into()));
    }
    let project_path = repository::get_project_path(&state.read_pool, project_id).await?;
    let resolved = resolve_ref(Path::new(&project_path), branch).await?;
    Ok((project_path, resolved))
}

pub(crate) async fn resolve_ref(repo: &Path, branch: &str) -> Result<String, AppError> {
    if local_branch_exists(repo, branch).await {
        return Ok(branch.to_string());
    }
    if let Some((_remote, suffix)) = branch.split_once('/') {
        if !suffix.is_empty() && remote_branch_exists(repo, branch).await {
            return Ok(suffix.to_string());
        }
    }
    Err(AppError::git_rejected(format!(
        "error: pathspec '{branch}' did not match any file(s) known to git"
    )))
}

/// Parse `git status --porcelain -uno` (tracked-only). Porcelain v1 lines
/// are `XY <path>`; rename lines are `XY old -> new` and both sides are
/// emitted so renames are caught regardless of which side the diff names.
fn parse_porcelain_dirty_files(porcelain: &str) -> Vec<String> {
    porcelain
        .lines()
        .filter(|l| l.len() >= 4)
        .flat_map(|line| {
            let rest = &line[3..];
            if let Some((old, new)) = rest.split_once(" -> ") {
                vec![old.trim().to_string(), new.trim().to_string()]
            } else {
                vec![rest.trim().to_string()]
            }
        })
        .filter(|p| !p.is_empty())
        .collect()
}

fn format_overwrite_error(files: &[String]) -> String {
    let mut msg = String::from(
        "error: Your local changes to the following files would be overwritten by checkout:\n",
    );
    for file in files {
        msg.push('\t');
        msg.push_str(file);
        msg.push('\n');
    }
    msg.push_str("Please commit your changes or stash them before you switch branches.");
    msg
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

    #[test]
    fn parses_modified_and_renamed_lines() {
        let status = " M src/a.rs\nM  src/b.rs\nR  old/c.rs -> new/c.rs\n";
        let dirty = parse_porcelain_dirty_files(status);
        assert_eq!(
            dirty,
            vec![
                "src/a.rs".to_string(),
                "src/b.rs".to_string(),
                "old/c.rs".to_string(),
                "new/c.rs".to_string(),
            ],
            "rename lines must emit both sides so the diff intersection catches the move",
        );
    }

    #[test]
    fn intersects_dirty_with_diff() {
        let diff: HashSet<&str> = ["src/a.rs", "src/b.rs"].into_iter().collect();
        let dirty = parse_porcelain_dirty_files(" M src/a.rs\n M README.md\n");
        let overlap: Vec<String> = dirty
            .into_iter()
            .filter(|p| diff.contains(p.as_str()))
            .collect();
        assert_eq!(overlap, vec!["src/a.rs".to_string()]);
    }

    #[test]
    fn overwrite_message_matches_git_wording() {
        let msg = format_overwrite_error(&["src/a.rs".into(), "src/b.rs".into()]);
        assert!(
            msg.starts_with("error: Your local changes to the following files would be overwritten by checkout:\n"),
            "{msg}"
        );
        assert!(msg.contains("\tsrc/a.rs\n"));
        assert!(msg.contains("\tsrc/b.rs\n"));
        assert!(
            msg.ends_with("Please commit your changes or stash them before you switch branches."),
            "{msg}"
        );
    }

    #[tokio::test]
    async fn checkout_is_refused_while_the_project_worktree_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &[
                "-c",
                "user.email=t@e",
                "-c",
                "user.name=T",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "seed",
            ][..],
            &["branch", "other"][..],
        ] {
            run_git(args, repo).await.unwrap();
        }
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'repo', ?)")
            .bind(repo.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::with_pool(pool);
        let _busy = state.git_mutations.try_acquire(repo).unwrap();

        let error = checkout(
            &state,
            CheckoutBody {
                project_id: 1,
                branch: "other".into(),
            },
        )
        .await
        .unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
        assert_eq!(
            run_git(&["symbolic-ref", "--short", "HEAD"], repo)
                .await
                .unwrap()
                .trim(),
            "main"
        );
    }

    #[tokio::test]
    async fn resolve_ref_returns_pathspec_error_for_missing_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        run_git(&["init", "-q"], repo).await.unwrap();
        let err = resolve_ref(repo, "no-such-branch").await.unwrap_err();
        match err {
            AppError::GitRejected(rejection) => {
                assert_eq!(rejection.kind, crate::error::GitFailureKind::RefNotFound);
                assert!(
                    rejection.message.contains("pathspec 'no-such-branch'"),
                    "{}",
                    rejection.message
                )
            }
            other => panic!("expected GitRejected, got {other:?}"),
        }
    }

    async fn response_body(error: AppError) -> (axum::http::StatusCode, serde_json::Value) {
        use axum::response::IntoResponse;
        let response = error.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn conflicting_checkout_is_a_409_with_git_message() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Test"],
            &["config", "commit.gpgsign", "false"],
        ] {
            run_git(args, repo).await.unwrap();
        }
        std::fs::write(repo.join("a.txt"), "main\n").unwrap();
        run_git(&["add", "a.txt"], repo).await.unwrap();
        run_git(&["commit", "-qm", "main"], repo).await.unwrap();
        run_git(&["checkout", "-qb", "other"], repo).await.unwrap();
        std::fs::write(repo.join("a.txt"), "other\n").unwrap();
        run_git(&["commit", "-qam", "other"], repo).await.unwrap();
        run_git(&["checkout", "-q", "main"], repo).await.unwrap();
        std::fs::write(repo.join("a.txt"), "dirty\n").unwrap();

        let error = run_git_capture(&["checkout"], &[], &["other"], repo)
            .await
            .unwrap_err();
        let (status, body) = response_body(error).await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "GIT_LOCAL_CHANGES_CONFLICT");
        let message = body["error"].as_str().unwrap();
        assert!(
            message.contains("would be overwritten by checkout"),
            "{message}"
        );
        assert!(message.contains("a.txt"), "{message}");
    }

    #[tokio::test]
    async fn missing_branch_is_a_422_with_git_message() {
        let dir = tempfile::tempdir().unwrap();
        run_git(&["init", "-q"], dir.path()).await.unwrap();
        let error = resolve_ref(dir.path(), "no-such-branch").await.unwrap_err();
        let (status, body) = response_body(error).await;
        assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body,
            serde_json::json!({
                "error": "error: pathspec 'no-such-branch' did not match any file(s) known to git",
                "code": "GIT_REF_NOT_FOUND"
            })
        );
    }
}
