//! Worktree-level deduplicated status recomputation and WS fan-out.
//!
//! Computes the worktree-level Git base once for a canonical worktree, resolves
//! per-feature target branches with the already-known HEAD, deduplicates target
//! divergence probes across features sharing that checkout, and broadcasts
//! tailored `git.status` / `git.status_error` envelopes.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::{mpsc, Mutex};
use tracing::warn;

use super::handle::{repo_lock, RegistryInner};
use super::subscription::broadcast_envelope;
use crate::app_state::AppState;
use crate::domain::git::git_status::{self, WorktreeStatusBase};
use crate::domain::git::workflow_service;
use crate::domain::ws_session::protocol::WsEnvelope;
use crate::error::AppError;

type FeatureSenders = Vec<mpsc::UnboundedSender<Message>>;
type ReadyFeature = (i64, String, FeatureSenders);

/// Compute the worktree-level Git base once for `worktree_path`, resolve each
/// subscribed feature's target branch, deduplicate divergence checks, and
/// broadcast per-feature envelopes.
///
/// Returns `true` when Git work ran, `false` when skipped (no subscribers,
/// foreground mutation active, or superseded by a newer write generation).
pub(super) async fn recompute_for_path(
    registry: &Arc<Mutex<RegistryInner>>,
    worktree_path: &Path,
    state: &AppState,
    expected_write_generation: Option<(Arc<AtomicU64>, u64)>,
) -> bool {
    recompute_for_path_with_base(
        registry,
        worktree_path,
        state,
        expected_write_generation,
        |path| async move { git_status::compute_worktree_base(&path).await },
    )
    .await
}

async fn recompute_for_path_with_base<F, Fut>(
    registry: &Arc<Mutex<RegistryInner>>,
    worktree_path: &Path,
    state: &AppState,
    expected_write_generation: Option<(Arc<AtomicU64>, u64)>,
    compute_base: F,
) -> bool
where
    F: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = Result<WorktreeStatusBase, AppError>>,
{
    if state.git_mutations.is_active_canonical(worktree_path) {
        return false;
    }
    let repo_lock = repo_lock(registry, worktree_path).await;
    let _repo = repo_lock.lock().await;
    if generation_changed(&expected_write_generation)
        || state.git_mutations.is_active_canonical(worktree_path)
    {
        return false;
    }

    let by_feature = snapshot_subscribers_by_feature(registry, worktree_path).await;
    if by_feature.is_empty() {
        return false;
    }

    let base = match compute_base(worktree_path.to_path_buf()).await {
        Ok(base) => base,
        Err(err) => {
            if !generation_changed(&expected_write_generation) {
                for (fid, senders) in by_feature {
                    broadcast_status_error(fid, worktree_path, &err, &senders);
                }
            }
            return true;
        }
    };

    let (ready_features, distinct_targets) = resolve_feature_targets(
        state,
        worktree_path,
        by_feature,
        &base,
        &expected_write_generation,
    )
    .await;
    resolve_and_broadcast_snapshots(
        state,
        worktree_path,
        &base,
        ready_features,
        &distinct_targets,
        &expected_write_generation,
    )
    .await;
    true
}

async fn resolve_feature_targets(
    state: &AppState,
    worktree_path: &Path,
    by_feature: HashMap<i64, FeatureSenders>,
    base: &WorktreeStatusBase,
    expected_write_generation: &Option<(Arc<AtomicU64>, u64)>,
) -> (Vec<ReadyFeature>, Vec<String>) {
    let checked_out = base.checked_out_branch();
    let has_git = base.has_git();
    let resolved =
        futures::future::join_all(by_feature.into_iter().map(|(fid, senders)| async move {
            let result = workflow_service::resolve_target_branch_with_head(
                state,
                fid,
                worktree_path,
                checked_out,
                has_git,
            )
            .await;
            (fid, senders, result)
        }))
        .await;

    let mut ready_features = Vec::with_capacity(resolved.len());
    let mut distinct_targets: Vec<String> = Vec::new();
    for (fid, senders, result) in resolved {
        match result {
            Ok(target) => {
                if !distinct_targets.contains(&target) {
                    distinct_targets.push(target.clone());
                }
                ready_features.push((fid, target, senders));
            }
            Err(err) => {
                if !generation_changed(expected_write_generation) {
                    broadcast_status_error(fid, worktree_path, &err, &senders);
                }
            }
        }
    }
    (ready_features, distinct_targets)
}

async fn resolve_and_broadcast_snapshots(
    state: &AppState,
    worktree_path: &Path,
    base: &WorktreeStatusBase,
    ready_features: Vec<ReadyFeature>,
    distinct_targets: &[String],
    expected_write_generation: &Option<(Arc<AtomicU64>, u64)>,
) {
    let metrics_by_target =
        git_status::resolve_targets_for_base(worktree_path, base, distinct_targets).await;
    let path_str = worktree_path.to_string_lossy().into_owned();
    let fanout = ready_features.into_iter().map(|(fid, target, senders)| {
        let metrics_result = metrics_by_target.get(&target);
        let path_str = &path_str;
        async move {
            let metrics = match metrics_result {
                Some(Ok(metrics)) => Some(metrics),
                Some(Err(err)) => {
                    if !generation_changed(expected_write_generation) {
                        broadcast_status_error(fid, worktree_path, err, &senders);
                    }
                    return;
                }
                None => None,
            };
            let mut snap = git_status::build_snapshot(base, fid, &target, metrics);
            workflow_service::enrich_snapshot(state, &mut snap, path_str).await;
            if generation_changed(expected_write_generation) {
                return;
            }
            let env = WsEnvelope::new("git", "status", serde_json::to_value(&snap).unwrap());
            broadcast_envelope(&senders, &env);
        }
    });

    futures::future::join_all(fanout).await;
}

async fn snapshot_subscribers_by_feature(
    registry: &Arc<Mutex<RegistryInner>>,
    worktree_path: &Path,
) -> HashMap<i64, FeatureSenders> {
    let snapshot_inputs: Vec<(i64, mpsc::UnboundedSender<Message>)> = {
        let inner = registry.lock().await;
        match inner.handles.get(worktree_path) {
            Some(handle) => handle
                .subscribers
                .iter()
                .map(|s| (s.feature_id, s.sender.clone()))
                .collect(),
            None => return HashMap::new(),
        }
    };
    let mut by_feature: HashMap<i64, FeatureSenders> = HashMap::new();
    for (fid, tx) in snapshot_inputs {
        by_feature.entry(fid).or_default().push(tx);
    }
    by_feature
}

fn broadcast_status_error(
    feature_id: i64,
    worktree_path: &Path,
    err: &AppError,
    senders: &[mpsc::UnboundedSender<Message>],
) {
    warn!(
        feature_id,
        path = %worktree_path.display(),
        error = %err,
        "git watcher: compute_status failed"
    );
    let env = WsEnvelope::new(
        "git",
        "status_error",
        serde_json::json!({
            "feature_id": feature_id,
            "error": err.to_string(),
        }),
    );
    broadcast_envelope(senders, &env);
}

fn generation_changed(expected: &Option<(Arc<AtomicU64>, u64)>) -> bool {
    expected
        .as_ref()
        .is_some_and(|(generation, value)| generation.load(Ordering::Acquire) != *value)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::super::handle::{spawn_handle, Subscriber};
    use super::super::registry::GitWatcherRegistry;
    use super::*;

    fn run_git_sync(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("HOME", dir)
            .output()
            .expect("git spawn");
        assert!(
            out.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[tokio::test]
    async fn shared_worktree_computes_base_once_and_delivers_tailored_snapshots_to_three_features()
    {
        let dir = tempfile::tempdir().unwrap();
        run_git_sync(dir.path(), &["init", "-q", "-b", "main"]);
        run_git_sync(dir.path(), &["config", "user.email", "t@t"]);
        run_git_sync(dir.path(), &["config", "user.name", "T"]);
        run_git_sync(dir.path(), &["config", "commit.gpgsign", "false"]);
        std::fs::write(dir.path().join("seed.txt"), "seed\n").unwrap();
        run_git_sync(dir.path(), &["add", "."]);
        run_git_sync(dir.path(), &["commit", "-q", "-m", "seed"]);

        run_git_sync(dir.path(), &["checkout", "-q", "-b", "develop"]);
        std::fs::write(dir.path().join("dev.txt"), "dev\n").unwrap();
        run_git_sync(dir.path(), &["add", "."]);
        run_git_sync(dir.path(), &["commit", "-q", "-m", "dev"]);
        run_git_sync(dir.path(), &["checkout", "-q", "-b", "feat"]);
        std::fs::write(dir.path().join("feat.txt"), "feat\n").unwrap();
        run_git_sync(dir.path(), &["add", "."]);
        run_git_sync(dir.path(), &["commit", "-q", "-m", "feat"]);

        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let canonical_str = canonical.to_string_lossy().into_owned();
        let pool = crate::domain::git::service::test_support::setup_diff_refs_schema().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', ?)")
            .bind(&canonical_str)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title) VALUES
                (1, 1, 'f1'),
                (2, 1, 'f2'),
                (3, 1, 'f3')",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (fid, target) in [(1, "main"), (2, "develop"), (3, "main")] {
            crate::domain::git::repository::set_feature_setting(
                &pool,
                fid,
                "target_branch",
                target,
            )
            .await
            .unwrap();
        }
        let state = AppState::with_pool(pool);
        let registry = GitWatcherRegistry::new();
        let mut handle = spawn_handle(registry.inner.clone(), canonical.clone(), state.clone())
            .await
            .unwrap();
        let mut receivers = Vec::new();
        for fid in [1_i64, 2, 3] {
            let (tx, rx) = mpsc::unbounded_channel::<Message>();
            handle.subscribers.push(Subscriber {
                feature_id: fid,
                sender: tx,
            });
            receivers.push((fid, rx));
        }
        registry
            .inner
            .lock()
            .await
            .handles
            .insert(canonical.clone(), handle);

        let base_calls = Arc::new(AtomicUsize::new(0));
        let did_compute =
            recompute_for_path_with_base(&registry.inner, &canonical, &state, None, {
                let base_calls = Arc::clone(&base_calls);
                move |path| async move {
                    base_calls.fetch_add(1, Ordering::SeqCst);
                    git_status::compute_worktree_base(&path).await
                }
            })
            .await;
        assert!(did_compute);
        assert_eq!(
            base_calls.load(Ordering::SeqCst),
            1,
            "worktree-level git base must run once for 3 subscribed features"
        );

        let mut snapshots = HashMap::new();
        for (fid, mut rx) in receivers {
            let Message::Text(text) = rx.try_recv().expect("each feature must receive a snapshot")
            else {
                panic!("expected text envelope");
            };
            let env: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(env["action"], "status");
            let snap: git_status::GitStatusSnapshot =
                serde_json::from_value(env["payload"].clone()).unwrap();
            assert_eq!(snap.feature_id, fid);
            snapshots.insert(fid, snap);
        }

        assert_eq!(snapshots[&1].target_branch, "main");
        assert_eq!(snapshots[&1].ahead_of_target, 2);
        assert_eq!(snapshots[&2].target_branch, "develop");
        assert_eq!(snapshots[&2].ahead_of_target, 1);
        assert_eq!(snapshots[&3].target_branch, "main");
        assert_eq!(snapshots[&3].ahead_of_target, 2);

        registry.shutdown().await;
    }
}
