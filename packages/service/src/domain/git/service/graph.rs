//! Service layer for the Git-tab graph views. The default graph logs `HEAD`
//! plus the local target branch; the Branches sub-tab can instead request one
//! dedicated local or remote-tracking branch ref.

use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::host;
use crate::domain::git::models::{
    CommitGraphResponse, CommitUrlResponse, GetCommitGraphParams, GetCommitUrlParams,
};
use crate::error::AppError;
use crate::shared::git_cli::run_git_background;

use super::resolve_feature_git_path;

/// Map a resolved target ref to its *local* branch when one exists. The shared
/// `resolve_target_branch` fallback prefers `origin/<name>` (the remote tip),
/// but the graph view is explicitly a local comparison: if `origin/main` was
/// chosen yet a local `main` exists, we log against `main`. Picks already
/// pointing at a local branch pass through unchanged.
async fn prefer_local_target(repo: &Path, target: &str) -> String {
    if crate::domain::git::workflow_service::local_branch_exists(repo, target).await {
        return target.to_string();
    }
    // `<remote>/<name>` → try the bare `<name>` against the local branches.
    if let Ok(remotes) = run_git_background(&["remote"], repo).await {
        for remote in remotes.lines().map(str::trim).filter(|r| !r.is_empty()) {
            if let Some(local) = target.strip_prefix(&format!("{remote}/")) {
                if crate::domain::git::workflow_service::local_branch_exists(repo, local).await {
                    return local.to_string();
                }
            }
        }
    }
    target.to_string()
}

pub async fn get_commit_graph(
    state: &AppState,
    params: GetCommitGraphParams,
) -> Result<CommitGraphResponse, AppError> {
    let git_path = match resolve_feature_git_path(state, params.feature_id).await? {
        Some(p) => p,
        None => return Ok(empty_graph()),
    };
    let path = Path::new(&git_path);

    let selected_branch =
        validate_selected_branch(params.branch.as_deref(), params.branch_is_local)?;
    let scope = if let Some(branch) = selected_branch {
        GraphScope {
            tips: vec![resolve_branch_ref(path, &branch).await?],
            current_branch: None,
            target_for_view: None,
        }
    } else {
        default_graph_scope(state, params.feature_id, path).await?
    };
    let GraphScope {
        tips,
        current_branch,
        target_for_view,
    } = scope;

    // Fetch one extra row to detect whether more commits exist past this page.
    let fetched = commands::get_commit_graph(path, &tips, params.skip, params.limit + 1).await?;
    let has_more = fetched.len() as i64 > params.limit;
    let commits = fetched
        .into_iter()
        .take(params.limit.max(0) as usize)
        .collect();

    Ok(CommitGraphResponse {
        commits,
        has_more,
        current_branch,
        target_branch: target_for_view,
    })
}

#[derive(Debug, PartialEq)]
struct SelectedBranch {
    name: String,
    is_local: bool,
}

fn validate_selected_branch(
    branch: Option<&str>,
    branch_is_local: Option<bool>,
) -> Result<Option<SelectedBranch>, AppError> {
    let (branch, is_local) = match (branch, branch_is_local) {
        (None, None) => return Ok(None),
        (Some(branch), Some(is_local)) => (branch, is_local),
        _ => {
            return Err(AppError::BadRequest(
                "branch and branch_is_local must be provided together".into(),
            ))
        }
    };
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(AppError::BadRequest("branch must not be blank".into()));
    }
    Ok(Some(SelectedBranch {
        name: branch.to_string(),
        is_local,
    }))
}

async fn resolve_branch_ref(path: &Path, branch: &SelectedBranch) -> Result<String, AppError> {
    let exists = if branch.is_local {
        crate::domain::git::workflow_service::local_branch_exists(path, &branch.name).await
    } else {
        crate::domain::git::workflow_service::remote_branch_exists(path, &branch.name).await
    };
    if !exists {
        return Err(AppError::BadRequest(format!(
            "branch does not exist: {}",
            branch.name
        )));
    }
    let prefix = if branch.is_local {
        "refs/heads"
    } else {
        "refs/remotes"
    };
    Ok(format!("{prefix}/{}", branch.name))
}

/// What the graph is drawn over: the revisions to walk plus the two branch
/// names the view labels itself with.
struct GraphScope {
    tips: Vec<String>,
    current_branch: Option<String>,
    target_for_view: Option<String>,
}

async fn default_graph_scope(
    state: &AppState,
    feature_id: i64,
    path: &Path,
) -> Result<GraphScope, AppError> {
    // The graph must be drawn from the branch it labels itself with, so a
    // feature whose worktree is gone keeps showing its own history. Resolving
    // the feature's scope and the target branch are independent, and each is
    // several git spawns, so they run concurrently.
    let (feature, resolved) = tokio::join!(
        super::resolve_feature_scope(&state.read_pool, feature_id, path),
        crate::domain::git::workflow_service::resolve_target_branch(state, feature_id, path),
    );
    let feature = feature?;
    let current_branch = feature.branch;
    let resolved = resolved.unwrap_or_else(|_| "main".to_string());
    let local_target = prefer_local_target(path, &resolved).await;

    let mut tips = vec![feature.revision];
    let on_target = current_branch.as_deref() == Some(local_target.as_str());
    let target_for_view = if !on_target
        && crate::domain::git::workflow_service::local_branch_exists(path, &local_target).await
    {
        tips.push(local_target.clone());
        Some(local_target)
    } else {
        None
    };
    Ok(GraphScope {
        tips,
        current_branch,
        target_for_view,
    })
}

/// Resolve the browser URL for a single commit on the feature's remote, so the
/// frontend's "open commit online" action can link out to GitHub/GitLab/etc.
pub async fn get_commit_url(
    state: &AppState,
    params: GetCommitUrlParams,
) -> Result<CommitUrlResponse, AppError> {
    let sha = params.sha.trim();
    let unavailable = CommitUrlResponse {
        url: String::new(),
        available: false,
    };
    if sha.is_empty() {
        return Ok(unavailable);
    }
    let git_path = match resolve_feature_git_path(state, params.feature_id).await? {
        Some(p) => p,
        None => return Ok(unavailable),
    };
    let commit_url = host::detect_origin_remote(Path::new(&git_path))
        .await
        .and_then(|info| host::commit_url(&info, sha));
    Ok(match commit_url {
        Some(url) => CommitUrlResponse {
            url,
            available: true,
        },
        None => unavailable,
    })
}

fn empty_graph() -> CommitGraphResponse {
    CommitGraphResponse {
        commits: vec![],
        has_more: false,
        current_branch: None,
        target_branch: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_branch_is_trimmed() {
        assert_eq!(
            validate_selected_branch(Some("  origin/feature/x  "), Some(false)).unwrap(),
            Some(SelectedBranch {
                name: "origin/feature/x".to_string(),
                is_local: false,
            })
        );
    }

    #[test]
    fn selected_branch_requires_a_non_blank_name_and_kind() {
        assert!(matches!(
            validate_selected_branch(Some("   "), Some(true)),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            validate_selected_branch(Some("main"), None),
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            validate_selected_branch(None, Some(true)),
            Err(AppError::BadRequest(_))
        ));
    }

    #[tokio::test]
    async fn branch_ref_resolution_accepts_only_local_or_remote_branches() {
        use crate::shared::git_cli::run_git;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path();
        run_git(&["init", "-q", "-b", "main"], path).await.unwrap();
        run_git(&["config", "user.email", "test@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "Test"], path)
            .await
            .unwrap();
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["config", "tag.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["commit", "--allow-empty", "-q", "-m", "base"], path)
            .await
            .unwrap();
        run_git(&["branch", "origin/main"], path).await.unwrap();
        run_git(&["update-ref", "refs/remotes/origin/main", "HEAD"], path)
            .await
            .unwrap();
        run_git(&["tag", "release"], path).await.unwrap();

        assert_eq!(
            resolve_branch_ref(
                path,
                &SelectedBranch {
                    name: "origin/main".into(),
                    is_local: true,
                }
            )
            .await
            .unwrap(),
            "refs/heads/origin/main"
        );
        assert_eq!(
            resolve_branch_ref(
                path,
                &SelectedBranch {
                    name: "origin/main".into(),
                    is_local: false,
                }
            )
            .await
            .unwrap(),
            "refs/remotes/origin/main"
        );
        assert!(matches!(
            resolve_branch_ref(
                path,
                &SelectedBranch {
                    name: "release".into(),
                    is_local: true,
                }
            )
            .await,
            Err(AppError::BadRequest(_))
        ));
    }
}
