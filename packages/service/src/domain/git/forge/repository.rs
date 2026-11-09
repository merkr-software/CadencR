use std::collections::HashSet;
use std::path::Path;

use futures::{stream, StreamExt};

use super::auth::{forge_to_app_error, host_configs, resolve_credentials};
use super::provider::{ForgeContext, ForgeProvider};
use super::{api_base_url, effective_kind, provider_for};
use crate::app_state::AppState;
use crate::domain::git::host::{detect_origin_remote, GitHost, RemoteInfo};
use crate::domain::git::linked_branches;
use crate::domain::git::service;
use crate::error::AppError;

/// A feature's forge, resolved end to end: which provider speaks for it, where
/// its API lives, and the credentials to reach it with.
pub struct FeatureForge {
    pub context: ForgeContext,
    pub kind: GitHost,
    pub provider: &'static dyn ForgeProvider,
}

/// Resolve everything a per-feature forge call needs, in one place.
///
/// Both the comment list and the image proxy have to agree on the host, the
/// kind, and the credentials for a feature — resolving them twice invites the
/// two to drift, and an image authenticated against a host the comment fetch
/// rejected would fail in a way neither route could explain.
pub async fn feature_forge_context(
    state: &AppState,
    feature_id: i64,
) -> Result<FeatureForge, AppError> {
    let target = resolve_feature_target(state, feature_id).await;
    if let Some(error) = target.error {
        return Err(AppError::internal(error));
    }
    let remote = target
        .remote
        .ok_or_else(|| AppError::BadRequest("Feature has no origin remote".into()))?;
    let configs = host_configs()?;
    let config = configs.get(&remote.hostname);
    let kind = effective_kind(remote.host, config);
    let provider = provider_for(kind)
        .ok_or_else(|| AppError::BadRequest("Configure this remote's forge kind".into()))?;
    let api_base_url = api_base_url(&remote.hostname, kind, config)
        .map_err(|error| forge_to_app_error(error))?
        .ok_or_else(|| AppError::BadRequest("Configure this forge's API base URL".into()))?;
    let credentials = resolve_credentials(&state.forge_auth, &remote.hostname, kind, config)
        .await
        .map_err(|error| forge_to_app_error(error))?
        .ok_or_else(|| AppError::BadRequest("Connect this forge in Settings first".into()))?;
    Ok(FeatureForge {
        context: ForgeContext {
            remote,
            api_base_url,
            credentials,
            http: state.forge_http.clone(),
        },
        kind,
        provider,
    })
}

#[derive(Debug, Clone)]
pub struct FeatureForgeTarget {
    pub feature_id: i64,
    /// The conversation's current branch.
    pub branch: Option<String>,
    /// Every branch to look proposals up for: the current one first, then
    /// the conversation's other linked branches.
    pub tracked: Vec<TrackedBranch>,
    pub remote: Option<RemoteInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TrackedBranch {
    pub name: String,
    /// Stored as one of the conversation's branches, so its proposal is worth
    /// remembering. False for the checkout a worktree-free conversation only
    /// follows: remembering it would link every branch the user visits.
    pub linked: bool,
    /// The proposal last recorded for it (number, state), which survives a
    /// restart where the in-memory snapshot does not.
    pub stored_pr: Option<(u64, String)>,
}

pub async fn active_feature_targets(state: &AppState) -> Result<Vec<FeatureForgeTarget>, AppError> {
    let feature_ids =
        sqlx::query_scalar::<_, i64>("SELECT id FROM features WHERE status = 'active' ORDER BY id")
            .fetch_all(&state.read_pool)
            .await?;
    Ok(stream::iter(feature_ids)
        .map(|feature_id| resolve_feature_target(state, feature_id))
        .buffered(8)
        .collect()
        .await)
}

pub async fn resolve_feature_target(state: &AppState, feature_id: i64) -> FeatureForgeTarget {
    match try_resolve_feature_target(state, feature_id).await {
        Ok((branch, remote)) => {
            match tracked_branches(state, feature_id, branch.as_deref()).await {
                Ok(tracked) => FeatureForgeTarget {
                    feature_id,
                    branch,
                    tracked,
                    remote,
                    error: None,
                },
                Err(error) => failed_target(feature_id, error),
            }
        }
        Err(error) => failed_target(feature_id, error),
    }
}

fn failed_target(feature_id: i64, error: AppError) -> FeatureForgeTarget {
    FeatureForgeTarget {
        feature_id,
        branch: None,
        tracked: Vec::new(),
        remote: None,
        error: Some(error.to_string()),
    }
}

async fn tracked_branches(
    state: &AppState,
    feature_id: i64,
    current: Option<&str>,
) -> Result<Vec<TrackedBranch>, AppError> {
    let rows = linked_branches::repository::list_linked(&state.read_pool, feature_id).await?;
    let mut tracked = rows
        .into_iter()
        .map(|row| TrackedBranch {
            stored_pr: row
                .pr_number
                .and_then(|number| u64::try_from(number).ok())
                .map(|number| (number, row.pr_state.unwrap_or_default())),
            name: row.branch,
            linked: true,
        })
        .collect::<Vec<_>>();
    if let Some(name) = service::recorded_feature_branch(&state.read_pool, feature_id).await? {
        if !tracked.iter().any(|branch| branch.name == name) {
            tracked.push(TrackedBranch {
                name,
                linked: true,
                stored_pr: None,
            });
        }
    }
    if let Some(current) = current {
        let entry = match tracked.iter().position(|branch| branch.name == current) {
            Some(index) => tracked.remove(index),
            None => TrackedBranch {
                name: current.to_string(),
                linked: false,
                stored_pr: None,
            },
        };
        tracked.insert(0, entry);
    }
    Ok(tracked)
}

pub async fn detected_project_remotes(state: &AppState) -> Result<Vec<RemoteInfo>, AppError> {
    let paths = sqlx::query_scalar::<_, String>("SELECT path FROM projects ORDER BY id")
        .fetch_all(&state.read_pool)
        .await?;
    let discovered = stream::iter(paths)
        .map(|path| async move { remote_for_path(Path::new(&path)).await })
        .buffered(8)
        .collect::<Vec<_>>()
        .await;
    let mut remotes = Vec::new();
    let mut seen = HashSet::new();
    for remote in discovered {
        let Some(remote) = remote? else {
            continue;
        };
        let key = format!("{}:{}/{}", remote.hostname, remote.owner, remote.repo);
        if seen.insert(key) {
            remotes.push(remote);
        }
    }
    Ok(remotes)
}

async fn try_resolve_feature_target(
    state: &AppState,
    feature_id: i64,
) -> Result<(Option<String>, Option<RemoteInfo>), AppError> {
    let path = service::resolve_feature_working_path(state, feature_id)
        .await?
        .ok_or_else(|| {
            AppError::NotFound(format!("No repository found for feature {feature_id}"))
        })?;
    if !crate::shared::git_context::has_git_metadata(Path::new(&path)).await? {
        return Ok((None, None));
    }
    // The branch the feature is *bound to*, not whatever the resolved
    // repository happens to have checked out: a feature whose worktree was
    // removed, or one created by the worktree-free "From branch" flow, both
    // resolve to the project directory, whose HEAD is usually the default
    // branch. Matching PRs against that would report the wrong proposal.
    let branch =
        service::resolve_feature_branch(&state.read_pool, feature_id, Path::new(&path)).await?;
    let remote = detect_origin_remote(Path::new(&path)).await;
    Ok((branch, remote))
}

async fn remote_for_path(path: &Path) -> Result<Option<RemoteInfo>, AppError> {
    if !crate::shared::git_context::has_git_metadata(path).await? {
        return Ok(None);
    }
    Ok(detect_origin_remote(path).await)
}
