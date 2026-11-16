//! Every branch a conversation has worked on.
//!
//! A conversation is provisioned on one branch (`worktree_branch` /
//! `feature_branch`, see [`super::service::recorded_feature_branch`]) but
//! rarely stays on just that one: the agent opens a follow-up branch, the user
//! stacks a fix on top. `feature_branches` tracks the whole set so the header
//! can list it, each branch keeps its own compare target, and the forge poller
//! follows each one's pull / merge request.
//!
//! Discovery, most to least certain:
//! - a manual link from the header ([`routes`]);
//! - the conversation's own, unshared worktree checking a branch out — seen
//!   by every git status recompute ([`observe_checkout`]);
//! - a checkout in the conversation's directory during one of its agent
//!   turns, read back from the reflog when the turn ends ([`turn_watch`]).
//!   The only signal for conversations without a worktree, whose directory is
//!   shared with the project and everything else working in it.
//!
//! Automatic discovery never links the repository's default branch: going
//! back to the trunk is leaving a branch, not starting one.

mod reflog;
pub mod repository;
pub mod routes;
mod turn_watch;

use std::path::Path;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::domain::git::forge::{self, PrState};
use crate::domain::git::git_status::GitStatusSnapshot;
use crate::domain::git::repository as settings;
use crate::domain::git::service::{
    current_feature_branch, is_own_worktree, recorded_feature_branch, SETTING_TARGET_BRANCH,
};
use crate::domain::git::workflow_service::{resolve_default_branch, same_branch_identity};
use crate::error::AppError;

pub use turn_watch::spawn;

/// How a branch came to belong to a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum BranchOrigin {
    /// The branch the conversation was created on.
    Provisioned,
    /// Seen checked out in the conversation's own worktree.
    CheckedOut,
    /// Checked out during one of the conversation's agent turns.
    Agent,
    /// Linked by the user.
    Manual,
    /// Not stored: the checkout a worktree-free conversation simply follows.
    Head,
}

impl BranchOrigin {
    pub fn as_db(self) -> &'static str {
        match self {
            Self::Provisioned => "provisioned",
            Self::CheckedOut => "checked_out",
            Self::Agent => "agent",
            Self::Manual | Self::Head => "manual",
        }
    }

    fn from_db(value: &str) -> Self {
        match value {
            "provisioned" => Self::Provisioned,
            "checked_out" => Self::CheckedOut,
            "agent" => Self::Agent,
            _ => Self::Manual,
        }
    }
}

pub(crate) fn pr_state_to_db(state: PrState) -> &'static str {
    match state {
        PrState::Open => "open",
        PrState::Draft => "draft",
        PrState::Merged => "merged",
        PrState::Closed => "closed",
    }
}

/// One branch of one conversation — the key of a `feature_branches` row.
#[derive(Debug, Clone, Copy)]
pub struct BranchRef<'a> {
    pub feature_id: i64,
    pub branch: &'a str,
}

/// A conversation branch as the header lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct ThreadBranch {
    pub name: String,
    pub origin: BranchOrigin,
    /// The branch's compare target. For the current branch this is the
    /// resolved target (the snapshot's `target_branch`); for the others it is
    /// the one configured for them (their own, else the conversation-wide
    /// one), or `None` when they follow the default.
    pub target_branch: Option<String>,
    pub is_current: bool,
    /// `None` for a branch that has no row of its own (the provisioned branch
    /// before it ever carried a target, or the followed checkout).
    pub last_seen_at: Option<String>,
}

/// The target configured for `branch`: its own, else the conversation-wide
/// one every branch had before targets became per branch.
pub async fn configured_target(
    pool: &SqlitePool,
    feature_id: i64,
    branch: Option<&str>,
) -> Result<Option<String>, AppError> {
    if let Some(branch) = branch {
        let key = BranchRef { feature_id, branch };
        if let Some(target) = repository::stored_target(pool, key).await? {
            return Ok(Some(target));
        }
    }
    legacy_target(pool, feature_id).await
}

async fn legacy_target(pool: &SqlitePool, feature_id: i64) -> Result<Option<String>, AppError> {
    Ok(
        settings::get_feature_setting(pool, feature_id, SETTING_TARGET_BRANCH)
            .await?
            .filter(|value| !value.trim().is_empty()),
    )
}

/// The header's branch list: the current branch first, then the others most
/// recently seen first.
pub async fn thread_branches(
    pool: &SqlitePool,
    feature_id: i64,
    current: Option<&str>,
    current_target: &str,
) -> Result<Vec<ThreadBranch>, AppError> {
    let recorded = recorded_feature_branch(pool, feature_id).await?;
    let legacy = legacy_target(pool, feature_id).await?;
    let mut branches = repository::list_linked(pool, feature_id)
        .await?
        .into_iter()
        .map(|row| ThreadBranch {
            origin: if recorded.as_deref() == Some(row.branch.as_str()) {
                BranchOrigin::Provisioned
            } else {
                BranchOrigin::from_db(&row.origin)
            },
            target_branch: row.target_branch.or_else(|| legacy.clone()),
            is_current: false,
            last_seen_at: Some(row.last_seen_at),
            name: row.branch,
        })
        .collect::<Vec<_>>();
    if let Some(recorded) = recorded {
        if !branches.iter().any(|branch| branch.name == recorded) {
            branches.push(ThreadBranch {
                name: recorded,
                origin: BranchOrigin::Provisioned,
                target_branch: legacy,
                is_current: false,
                last_seen_at: None,
            });
        }
    }
    if let Some(current) = current {
        match branches.iter().position(|branch| branch.name == current) {
            Some(index) => {
                let mut branch = branches.remove(index);
                branch.is_current = true;
                branches.insert(0, branch);
            }
            None => branches.insert(
                0,
                ThreadBranch {
                    name: current.to_string(),
                    origin: BranchOrigin::Head,
                    target_branch: None,
                    is_current: true,
                    last_seen_at: None,
                },
            ),
        }
        branches[0].target_branch = Some(current_target.to_string());
    }
    Ok(branches)
}

/// Fill `snapshot.thread_branches`, first recording the checkout if it
/// happened in the conversation's own worktree. Best-effort like the sharing
/// enrichment: a failure leaves the list empty and the header falls back to
/// the live branch.
pub async fn enrich_snapshot(state: &AppState, snapshot: &mut GitStatusSnapshot, path: &str) {
    let feature_id = snapshot.feature_id;
    let live = snapshot.checked_out_branch();
    let current = match observe(state, snapshot, live, Path::new(path)).await {
        Ok(current) => current,
        Err(error) => {
            tracing::warn!(feature_id, %error, "linked branches: resolving the current branch failed");
            return;
        }
    };
    match thread_branches(
        &state.read_pool,
        feature_id,
        current.as_deref(),
        &snapshot.target_branch,
    )
    .await
    {
        Ok(branches) => snapshot.thread_branches = branches,
        Err(error) => {
            tracing::warn!(feature_id, %error, "linked branches: listing failed");
        }
    }
}

/// Record the checkout when `path` is the conversation's own worktree, then
/// resolve its current branch. Re-polls the forge when either moved the
/// current branch: its pull request is now the current one.
async fn observe(
    state: &AppState,
    snapshot: &GitStatusSnapshot,
    live: Option<String>,
    path: &Path,
) -> Result<Option<String>, AppError> {
    let feature_id = snapshot.feature_id;
    let own = is_own_worktree(&state.read_pool, feature_id, path).await?;
    let mut linked = false;
    if let (true, Some(branch)) = (own && snapshot.shared_with.is_empty(), live.as_deref()) {
        linked = observe_checkout(state, feature_id, branch, path).await?;
    }
    // Nobody else switches branches in the feature's own worktree.
    let current = match live {
        Some(live) if own => Some(live),
        live => current_feature_branch(&state.read_pool, feature_id, path, live).await?,
    };
    let moved = match current.as_deref() {
        Some(current) => {
            state
                .forge_status
                .note_current_branch(feature_id, current)
                .await
        }
        None => false,
    };
    if linked || moved {
        forge::request_refresh(state);
    }
    Ok(current)
}

/// Push the new branch list to open views and re-poll the forge, so a newly
/// linked branch's pull request shows up without waiting for the next tick.
pub(crate) async fn refresh_after_change(state: &AppState, feature_id: i64) {
    crate::domain::git::workflow_service::broadcast_after_write(state, feature_id).await;
    forge::request_refresh(state);
}

/// Link `branch`, checked out in the conversation's own worktree — nobody
/// else switches branches there. Returns whether a row was written. The
/// cheap checks run first: this runs on every git status recompute.
async fn observe_checkout(
    state: &AppState,
    feature_id: i64,
    branch: &str,
    path: &Path,
) -> Result<bool, AppError> {
    if recorded_feature_branch(&state.read_pool, feature_id)
        .await?
        .as_deref()
        == Some(branch)
    {
        return Ok(false);
    }
    let rows = repository::list_linked(&state.read_pool, feature_id).await?;
    if rows.first().is_some_and(|row| row.branch == branch) {
        return Ok(false);
    }
    let key = BranchRef { feature_id, branch };
    if repository::is_unlinked(&state.read_pool, key).await? {
        return Ok(false);
    }
    // Checking the trunk out is not working on it: never link it implicitly.
    if same_branch_identity(branch, &resolve_default_branch(path).await?) {
        return Ok(false);
    }
    repository::record_seen(&state.write_pool, key, BranchOrigin::CheckedOut, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::service::test_support::setup_diff_refs_schema;

    async fn pool_with_feature() -> SqlitePool {
        let pool = setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn key(branch: &str) -> BranchRef<'_> {
        BranchRef {
            feature_id: 1,
            branch,
        }
    }

    async fn linked_names(pool: &SqlitePool) -> Vec<String> {
        repository::list_linked(pool, 1)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.branch)
            .collect()
    }

    async fn seen(pool: &SqlitePool, branch: &str, at: &str) {
        repository::record_seen(pool, key(branch), BranchOrigin::Agent, Some(at))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn lists_the_current_branch_first_with_its_resolved_target() {
        let pool = pool_with_feature().await;
        settings::set_feature_setting(&pool, 1, "worktree_branch", "feature/a")
            .await
            .unwrap();
        settings::set_feature_setting(&pool, 1, "target_branch", "main")
            .await
            .unwrap();
        seen(&pool, "fix/b", "2026-10-16T10:00:00.000Z").await;
        seen(&pool, "fix/c", "2026-10-16T11:00:00.000Z").await;
        repository::set_target(&pool, key("fix/b"), BranchOrigin::Agent, "feature/a")
            .await
            .unwrap();

        let branches = thread_branches(&pool, 1, Some("fix/b"), "feature/a")
            .await
            .unwrap();
        let summary = branches
            .iter()
            .map(|b| {
                (
                    b.name.as_str(),
                    b.origin,
                    b.is_current,
                    b.target_branch.as_deref(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            summary,
            vec![
                ("fix/b", BranchOrigin::Agent, true, Some("feature/a")),
                ("fix/c", BranchOrigin::Agent, false, Some("main")),
                ("feature/a", BranchOrigin::Provisioned, false, Some("main")),
            ]
        );
    }

    #[tokio::test]
    async fn a_followed_checkout_is_listed_but_not_stored() {
        let pool = pool_with_feature().await;
        let branches = thread_branches(&pool, 1, Some("main"), "origin/main")
            .await
            .unwrap();
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].origin, BranchOrigin::Head);
        assert_eq!(branches[0].target_branch.as_deref(), Some("origin/main"));
        assert!(linked_names(&pool).await.is_empty());
    }

    #[tokio::test]
    async fn unlinked_branches_stay_out_until_linked_by_hand() {
        let pool = pool_with_feature().await;
        seen(&pool, "fix/b", "2026-10-16T10:00:00.000Z").await;
        repository::unlink(&pool, key("fix/b")).await.unwrap();
        // Discovery does not bring it back...
        seen(&pool, "fix/b", "2026-10-16T12:00:00.000Z").await;
        assert!(linked_names(&pool).await.is_empty());
        assert!(repository::is_unlinked(&pool, key("fix/b")).await.unwrap());
        // ...a manual link does.
        repository::link_manual(&pool, key("fix/b")).await.unwrap();
        assert_eq!(linked_names(&pool).await, vec!["fix/b"]);
    }

    #[tokio::test]
    async fn an_older_sighting_never_moves_a_branch_back() {
        let pool = pool_with_feature().await;
        seen(&pool, "fix/b", "2026-10-16T12:00:00.000Z").await;
        let moved = repository::record_seen(
            &pool,
            key("fix/b"),
            BranchOrigin::Agent,
            Some("2026-10-16T09:00:00.000Z"),
        )
        .await
        .unwrap();
        assert!(!moved);
    }

    #[tokio::test]
    async fn the_checkout_is_current_only_when_it_is_one_of_the_branches() {
        let pool = pool_with_feature().await;
        settings::set_feature_setting(&pool, 1, "feature_branch", "feature/a")
            .await
            .unwrap();
        let current = |head: &str| {
            let pool = pool.clone();
            let head = head.to_string();
            async move {
                crate::domain::git::service::current_feature_branch(
                    &pool,
                    1,
                    Path::new("/not-a-feature-worktree"),
                    Some(head),
                )
                .await
                .unwrap()
            }
        };
        assert_eq!(current("main").await.as_deref(), Some("feature/a"));
        seen(&pool, "fix/b", "2026-10-16T10:00:00.000Z").await;
        assert_eq!(current("fix/b").await.as_deref(), Some("fix/b"));
    }

    #[tokio::test]
    async fn configured_target_prefers_the_branch_then_the_conversation() {
        let pool = pool_with_feature().await;
        assert_eq!(
            configured_target(&pool, 1, Some("fix/b")).await.unwrap(),
            None
        );
        settings::set_feature_setting(&pool, 1, "target_branch", "develop")
            .await
            .unwrap();
        assert_eq!(
            configured_target(&pool, 1, Some("fix/b"))
                .await
                .unwrap()
                .as_deref(),
            Some("develop")
        );
        repository::set_target(&pool, key("fix/b"), BranchOrigin::Manual, "feature/a")
            .await
            .unwrap();
        assert_eq!(
            configured_target(&pool, 1, Some("fix/b"))
                .await
                .unwrap()
                .as_deref(),
            Some("feature/a")
        );
    }
}
